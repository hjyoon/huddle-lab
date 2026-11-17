// Adapted from Buzz v1.0.4 bundled/codex/voice.ts.
// Copyright 2026 Block, Inc. Apache-2.0; see LICENSE and NOTICE.
// Modified: standalone provider, local connector, transcripts and interruption.
import type { AgentVoiceProvider, AgentVoiceContext, AgentVoiceConnection } from "../agent-voice/types.js";
import { createPlayout } from "../web-audio/playout.js";
import { abortable, type CodexVoiceSession } from "./rpc.js";
export { createCodexLocalConnector } from "./rpc.js";
export type { CodexVoiceSession, CodexNotification } from "./rpc.js";

type CodexVoiceOptions = {
  connect(signal: AbortSignal): Promise<CodexVoiceSession>;
  timeoutMs?: number;
  workletUrl?: string | URL;
};
type MediaConnection = AgentVoiceConnection & { frameless(): boolean };
type MediaProvider = Omit<AgentVoiceProvider, "open"> & {
  open(owner: AgentVoiceContext): Promise<MediaConnection>;
};
let mediaSerial = 0;

/** A voice session owns one Codex thread. A v3 manual interruption rotates its
 * realtime transport on that same thread; v3 has no response.cancel command. */
export function createCodexVoiceProvider(options: CodexVoiceOptions): AgentVoiceProvider {
  return { id: "local-codex", name: "Codex", async open(owner) {
    const lifetime = new AbortController();
    const signal = AbortSignal.any([owner.signal, lifetime.signal]);
    let session: CodexVoiceSession | undefined, media: MediaConnection | undefined;
    let opening: Promise<CodexVoiceSession> | undefined, openingMedia: Promise<MediaConnection> | undefined;
    let closing: Promise<void> | undefined, rotating: Promise<void> | undefined, closed = false;
    const emit: typeof owner.emit = (event) => {
      if (closed || owner.signal.aborted) return;
      owner.emit(event);
      if (event.type === "ended") void close().catch(() => {});
    };
    const start = () => {
      openingMedia = createMediaProvider({ ...options, connect: async () => ({
        threadId: session!.threadId,
        request: (...args) => session!.request(...args),
        subscribe: (...args) => session!.subscribe(...args),
        close: async () => {},
      }) })
        .open({ ...owner, signal, emit });
      return openingMedia;
    };
    function close(): Promise<void> {
      if (closing) return closing;
      closed = true; owner.signal.removeEventListener("abort", onAbort);
      const stopping = media?.close(); lifetime.abort();
      closing = Promise.resolve().then(async () => {
        try {
          await stopping;
          const lateMedia = await openingMedia?.catch(() => undefined);
          await lateMedia?.close(); await rotating?.catch(() => {});
        } finally {
          const owned = session ?? await opening?.catch(() => undefined);
          await owned?.close();
        }
      });
      return closing;
    }
    const onAbort = () => { void close().catch(() => {}); };
    owner.signal.addEventListener("abort", onAbort, { once: true });
    try {
      owner.signal.throwIfAborted();
      opening = options.connect(signal);
      session = await abortable(opening, AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs ?? 45000)]));
      signal.throwIfAborted();
      media = await start(); signal.throwIfAborted();
      return {
        input(samples) { if (!closed && !rotating) return media?.input(samples); },
        async interrupt(responseId) {
          if (closed || rotating || !media) return rotating;
          if (!media.frameless()) return media.interrupt(responseId);
          const previous = media; media = undefined;
          emit({ type: "activity", activity: "thinking" });
          rotating = (async () => {
            // Stop media immediately, then settle the old transport before a new offer.
            const stopping = previous.close();
            await session!.request("voice/interrupt", { threadId: session!.threadId });
            await stopping;
            if (!closed) media = await start();
          })();
          try { await rotating; } finally { rotating = undefined; }
        }, close,
      };
    } catch (error) { await close().catch(() => {}); throw error; }
  } };
}

function createMediaProvider(options: CodexVoiceOptions): MediaProvider {
  return {
    id: "local-codex", name: "Codex",
    async open(owner) {
      const lifetime = new AbortController();
      const signal = AbortSignal.any([owner.signal, lifetime.signal]);
      const startup = AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs ?? 45000)]);
      let session: CodexVoiceSession | undefined, audio: AudioContext | undefined;
      let peer: RTCPeerConnection | undefined, channel: RTCDataChannel | undefined;
      let capture: AudioWorkletNode | undefined, source: MediaStreamAudioSourceNode | undefined;
      let renderer: HTMLAudioElement | undefined;
      let destination: MediaStreamAudioDestinationNode | undefined;
      let playout: ReturnType<typeof createPlayout> | undefined, unsubscribe: (() => void) | undefined;
      let responseId: string | undefined, generating = false, generation = 0, serial = 0, canonical = false;
      let frameless = false, silence = 0; const prefix = `codex-media-${++mediaSerial}`;
      let transcript: { speaker: "user" | "assistant"; text: string } | undefined;
      let transcriptTimer: ReturnType<typeof setTimeout> | undefined, rpcTranscripts = false;
      let lastProjection: { speaker: string; text: string; at: number } | undefined;
      let starting: Promise<unknown> | undefined, closing: Promise<void> | undefined, closed = false;
      let opening: Promise<CodexVoiceSession> | undefined, audioClosed: Promise<void> | undefined;
      let settleConnected: (() => void) | undefined, rejectConnected: ((error: Error) => void) | undefined;
      const connected = new Promise<void>((resolve, reject) => { settleConnected = resolve; rejectConnected = reject; });
      void connected.catch(() => {});
      const emit: typeof owner.emit = (event) => { if (!closed && !signal.aborted) owner.emit(event); };
      const clearTranscript = () => { clearTimeout(transcriptTimer); transcriptTimer = undefined; transcript = undefined; };
      const flushTranscript = () => {
        if (transcript?.text.trim()) {
          emit({ type: "transcript", id: `${prefix}-transcript-${++serial}`, ...transcript });
          lastProjection = { ...transcript, at: Date.now() };
        }
        clearTranscript();
      };
      const appendTranscript = (speaker: "user" | "assistant", text: unknown) => {
        if (rpcTranscripts || typeof text !== "string" || !text) return;
        if (transcript && transcript.speaker !== speaker) flushTranscript();
        transcript ??= { speaker, text: "" };
        transcript.text = (transcript.text + text).slice(0, 16000);
        clearTimeout(transcriptTimer);
        // A display segment, not a server turn boundary. Older CLI versions
        // don't convert the newest Live deltas into canonical RPC items.
        transcriptTimer = setTimeout(flushTranscript, 2000);
      };
      const finalTranscript = (id: string, speaker: "user" | "assistant", text: string) => {
        rpcTranscripts = true; clearTranscript();
        if (lastProjection?.speaker === speaker && lastProjection.text === text && Date.now() - lastProjection.at < 10000) return;
        emit({ type: "transcript", id, speaker, text });
      };
      const fence = () => { generation++; capture?.port.postMessage(generation); };
      const endResponse = (interrupted: boolean) => {
        if (responseId) emit({ type: interrupted ? "response-interrupted" : "response-ended", responseId });
        responseId = undefined; fence();
      };
      const fail = (error: unknown) => {
        if (closed) return;
        const message = error instanceof Error ? error.message : String(error);
        rejectConnected?.(new Error(message));
        emit({ type: "ended", error: message });
        void close().catch(() => {});
      };
      const physicalClose = () => {
        channel?.close(); peer?.close();
        if (renderer) { renderer.pause(); renderer.srcObject = null; }
        if (capture) { capture.port.onmessage = null; capture.port.close(); }
        capture?.disconnect(); source?.disconnect(); playout?.close();
        destination?.stream.getTracks().forEach((track) => track.stop());
        destination?.disconnect();
        peer?.getReceivers().forEach((receiver) => receiver.track?.stop());
        if (audio && audio.state !== "closed") audioClosed = audio.close().catch(() => {});
      };
      function close(): Promise<void> {
        if (closing) return closing;
        closed = true; clearTranscript(); unsubscribe?.(); signal.removeEventListener("abort", onAbort);
        physicalClose();
        closing = Promise.resolve().then(async () => {
          try {
            // A late start acknowledgment must finish before sending stop.
            await starting?.catch(() => {});
            if (session && starting) await session.request("thread/realtime/stop", { threadId: session.threadId }).catch(() => {});
          } finally {
            const owned = session ?? await opening?.catch(() => undefined);
            await owned?.close(); await audioClosed; lifetime.abort();
          }
        });
        return closing;
      }
      const onAbort = () => { rejectConnected?.(new Error("Codex voice connection cancelled.")); void close().catch(() => {}); };
      signal.addEventListener("abort", onAbort, { once: true });
      const control = (value: Record<string, unknown>) => {
        if (channel?.readyState === "open") channel.send(JSON.stringify(value));
      };
      try {
        // Keep ownership of a connector that settles after cancellation.
        opening = options.connect(signal);
        session = await abortable(opening, startup);
        startup.throwIfAborted();
        audio = new AudioContext({ sampleRate: 48000 });
        const context = audio;
        if (context.sampleRate !== 48000) throw new Error("Codex voice requires 48 kHz audio.");
        peer = new RTCPeerConnection();
        destination = context.createMediaStreamDestination();
        playout = createPlayout(context, destination, 0.02);
        for (const track of destination.stream.getTracks()) peer.addTrack(track, destination.stream);
        await abortable(context.audioWorklet.addModule(options.workletUrl ?? new URL("capture.worklet.js", import.meta.url)), startup);
        capture = new AudioWorkletNode(context, "codex-huddle-capture");
        capture.onprocessorerror = () => fail(new Error("Codex audio capture processor failed."));
        capture.port.onmessage = (event: MessageEvent<{ generation: number; samples: Float32Array }>) => {
          if (closed || event.data.generation !== generation) return;
          const samples = Array.from(event.data.samples);
          if (frameless) {
            // v3 is a continuous duplex stream, with no response/buffer boundaries.
            // Energy only projects the speaking indicator/local response IDs.
            const active = samples.some((value) => Math.abs(value) > 0.002);
            if (active) {
              silence = 0;
              if (!responseId) {
                responseId = `${prefix}-speech-${++serial}`;
                emit({ type: "response-started", responseId });
              }
            } else if (responseId && ++silence >= 20) {
              endResponse(false); emit({ type: "activity", activity: "listening" });
            }
          }
          if (responseId) emit({ type: "audio", responseId, samples });
        };
        capture.port.postMessage(generation);
        capture.connect(context.destination); // Worklet writes silence; Huddle owns audible playout.
        peer.ontrack = ({ track }) => {
          if (closed || track.kind !== "audio") return;
          source?.disconnect();
          const stream = new MediaStream([track]);
          // Chromium needs an active remote media renderer to advance its RTP
          // playout clock. Keep it muted: the Huddle owns audible output.
          renderer ??= new Audio(); renderer.muted = true; renderer.srcObject = stream;
          void renderer.play().catch(fail);
          source = context.createMediaStreamSource(stream);
          source.connect(capture!);
        };
        peer.onconnectionstatechange = () => {
          if (peer?.connectionState === "connected") settleConnected?.();
          else if (["failed", "disconnected", "closed"].includes(peer?.connectionState ?? "")) fail(new Error("Codex WebRTC connection ended."));
        };
        channel = peer.createDataChannel("oai-events");
        channel.onerror = () => fail(new Error("Codex realtime data channel failed."));
        channel.onclose = () => fail(new Error("Codex realtime data channel closed."));
        channel.onmessage = (event) => {
          try {
            if (typeof event.data !== "string" || event.data.length > 512 * 1024) return;
            const item = JSON.parse(event.data);
            switch (item.type) {
              case "session.started": frameless = true; break;
              case "session.closed": fail(new Error(`Codex voice ended: ${String(item.reason ?? "remote closed")}`)); break;
              case "input_transcript.added":
              case "session.input_transcript.delta":
                appendTranscript("user", item.item?.text ?? item.delta);
                endResponse(true); emit({ type: "activity", activity: "listening" }); break;
              case "output_transcript.added":
              case "session.output_transcript.delta": appendTranscript("assistant", item.item?.text ?? item.delta); break;
              case "delegation.created": emit({ type: "activity", activity: "thinking" }); break;
              case "response.created": frameless = false; generating = true; emit({ type: "activity", activity: "thinking" }); break;
              case "response.done": generating = false; break;
              case "output_audio_buffer.started":
                endResponse(false);
                responseId = typeof item.response_id === "string" ? item.response_id : `${prefix}-response-${++serial}`;
                fence(); emit({ type: "response-started", responseId: responseId! }); break;
              case "output_audio_buffer.stopped": endResponse(false); emit({ type: "activity", activity: "listening" }); break;
              case "input_audio_buffer.speech_started":
              case "output_audio_buffer.cleared": endResponse(true); emit({ type: "activity", activity: "listening" }); break;
              case "error": fail(new Error(`${item.error?.code ? `${String(item.error.code)}: ` : ""}${String(item.error?.message ?? item.message ?? "Codex realtime error")}`)); break;
            }
          } catch (error) { fail(error); }
        };
        unsubscribe = session.subscribe((message) => {
          const params = message.params ?? {};
          if (message.method === "connection/closed") { fail(new Error("Local Codex disconnected.")); return; }
          if (params.threadId !== session?.threadId) return;
          if (message.method === "thread/realtime/sdp" && typeof params.sdp === "string") {
            void peer?.setRemoteDescription({ type: "answer", sdp: params.sdp }).catch(fail);
          } else if (message.method === "thread/realtime/error") fail(new Error(String(params.message ?? "Codex voice failed.")));
          else if (message.method === "thread/realtime/closed") fail(new Error(String(params.reason ?? "Codex voice ended.")));
          else if (message.method === "turn/started") emit({ type: "activity", activity: "thinking" });
          else if (message.method === "turn/completed") emit({ type: "activity", activity: "listening" });
          else if (message.method.startsWith("thread/realtime/item/")) {
            canonical = true;
            const item = params.item as Record<string, unknown> | undefined;
            if (item?.type === "transcriptSegment") { rpcTranscripts = true; clearTranscript(); }
            if (message.method.endsWith("completed") && item?.type === "transcriptSegment" &&
              (item.role === "user" || item.role === "assistant") && typeof item.text === "string" && typeof item.id === "string")
              finalTranscript(item.id, item.role, item.text);
          } else if (!canonical && message.method === "thread/realtime/transcript/done" &&
            (params.role === "user" || params.role === "assistant") && typeof params.text === "string")
            finalTranscript(`${prefix}-transcript-${++serial}`, params.role, params.text);
        });
        const offer = await abortable(peer.createOffer(), startup);
        await abortable(peer.setLocalDescription(offer), startup);
        starting = session.request("thread/realtime/start", {
          threadId: session.threadId, transport: { type: "webrtc", sdp: offer.sdp },
        });
        await abortable(Promise.all([starting, connected, context.resume()]), startup);
        startup.throwIfAborted();
        emit({ type: "activity", activity: "listening" });
        return {
          frameless: () => frameless,
          input(samples) { if (!closed) playout?.play(samples); },
          async interrupt() {
            if (closed) return;
            endResponse(true);
            if (generating) control({ type: "response.cancel" });
            control({ type: "output_audio_buffer.clear" }); generating = false;
            await session!.request("voice/interrupt", { threadId: session!.threadId });
          },
          close,
        };
      } catch (error) { await close().catch(() => {}); throw error; }
    },
  };
}
