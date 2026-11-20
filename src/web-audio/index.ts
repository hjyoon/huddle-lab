// Adapted from block/buzz-app v1.0.4 (a1c9c96940d2a6c81fce9beed9b7cbcc34b144b8).
// Copyright 2026 Block, Inc. Apache-2.0; see LICENSE and NOTICE.
// Modified: standalone worklet URL, no device picker, explicit processor failure
// cleanup, abort checks at each asynchronous setup boundary, and PCM validation.
import type { HuddleAudio, OpenHuddleAudio } from "../types.js";
import { createPlayout } from "./playout.js";

export type WebAudioOptions = {
  /** Override when the host serves or bundles the worklet at another URL.
   * Must allow AudioWorklet module loading under the host's origin/CSP. */
  workletUrl?: string | URL;
  /** Expose a resume action while playback is waiting for a browser gesture. */
  onResumePending?: (resume: () => Promise<void>) => (() => void);
};

/** Runs in an HTTPS/localhost browser context. Autostart callers can supply
 * a user-controlled resume action when the browser waits for a gesture.
 * No microphone access or browser globals are used during module import. */
export function createWebAudioAdapter(options: WebAudioOptions = {}): OpenHuddleAudio {
  const workletUrl = options.workletUrl ?? new URL("./capture.worklet.js", import.meta.url);
  return async (send, ended, signal): Promise<HuddleAudio> => {
    signal.throwIfAborted();
    const media = globalThis.navigator?.mediaDevices;
    if (!media?.getUserMedia)
      throw new Error("Microphone access requires a supported HTTPS or localhost browser.");
    if (typeof AudioContext === "undefined" || typeof AudioWorkletNode === "undefined")
      throw new Error("Web Audio with AudioWorklet is unavailable in this host.");
    const context = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
    let stream: MediaStream | undefined;
    let output: GainNode | undefined;
    let capture: AudioWorkletNode | undefined;
    let source: MediaStreamAudioSourceNode | undefined;
    let closed = false;
    let muted = false;
    const playback = new Map<string, ReturnType<typeof createPlayout>>();
    const stopStream = (value: MediaStream | undefined) => {
      for (const track of value?.getTracks() ?? []) {
        track.onended = null;
        track.stop();
      }
    };
    const clear = (peer: string) => {
      playback.get(peer)?.close();
      playback.delete(peer);
    };
    const close = () => {
      if (closed) return;
      closed = true;
      signal.removeEventListener("abort", close);
      if (capture) {
        capture.onprocessorerror = null;
        capture.port.onmessage = null;
        capture.port.close();
        capture.disconnect();
      }
      source?.disconnect();
      stopStream(stream);
      for (const peer of playback.keys()) clear(peer);
      output?.disconnect();
      void context.close().catch(() => {});
    };
    const unexpectedEnd = () => {
      if (closed) return;
      close();
      ended();
    };
    signal.addEventListener("abort", close, { once: true });
    try {
      output = context.createGain();
      output.connect(context.destination);
      const resumed = context.resume();
      const dismissResume = context.state === "suspended" ? options.onResumePending?.(() => context.resume()) : undefined;
      if (dismissResume) signal.addEventListener("abort", dismissResume, { once:true });
      try { await resumed; }
      finally {
        if (dismissResume) signal.removeEventListener("abort", dismissResume);
        dismissResume?.();
      }
      signal.throwIfAborted();
      if (context.sampleRate !== 48000)
        throw new Error("This audio device does not support 48 kHz Huddle audio.");
      if (!context.audioWorklet)
        throw new Error("AudioWorklet is unavailable in this host.");
      stream = await media.getUserMedia({ audio: {
        channelCount: 1, sampleRate: 48000,
        echoCancellation: true, noiseSuppression: true, autoGainControl: true,
      } });
      // getUserMedia itself is not abortable. Release a late permission grant.
      if (closed || signal.aborted) {
        stopStream(stream);
        stream = undefined;
        signal.throwIfAborted();
        throw new DOMException("Huddle audio closed", "AbortError");
      }
      const tracks = stream.getAudioTracks();
      if (!tracks.length || tracks.every((track) => track.readyState === "ended"))
        throw new Error("The microphone is no longer available.");
      for (const track of tracks) track.onended = unexpectedEnd;
      await context.audioWorklet.addModule(workletUrl.toString());
      signal.throwIfAborted();
      if (closed) throw new DOMException("Huddle audio closed", "AbortError");
      capture = new AudioWorkletNode(context, "buzz-huddle-capture");
      capture.onprocessorerror = unexpectedEnd;
      capture.port.onmessage = ({ data }: MessageEvent<Float32Array>) => {
        if (!closed && !muted && data instanceof Float32Array && data.length === 960)
          send(Array.from(data));
      };
      source = context.createMediaStreamSource(stream);
      source.connect(capture);
      // The worklet outputs silence; this keeps its capture processing alive.
      capture.connect(context.destination);
      return {
        close,
        mute(value) {
          if (closed) return;
          muted = value;
          for (const track of stream?.getAudioTracks() ?? []) track.enabled = !value;
        },
        participants(peers) {
          if (closed) return;
          for (const peer of playback.keys()) if (!peers.includes(peer)) clear(peer);
        },
        play(peer, samples) {
          if (closed || !samples.length || samples.length > 5760 ||
            samples.some((value) => !Number.isFinite(value))) return;
          let entry = playback.get(peer);
          if (!entry) {
            entry = createPlayout(context, output!, 0.06);
            playback.set(peer, entry);
          }
          entry.play(samples);
        },
      };
    } catch (error) {
      close();
      signal.throwIfAborted();
      throw error;
    }
  };
}

export const openWebAudio: OpenHuddleAudio = createWebAudioAdapter();
