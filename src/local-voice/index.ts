import type { AgentVoiceProvider } from "../agent-voice/types.js";
import { createSpeechGate } from "./vad.js";
import { isVoiceWebSocket } from "../voice-websocket.js";

/** Host-owned text inference + local STT/TTS. Binary frames are 960 Float32LE
 * samples; response frames prepend an unsigned little-endian turn sequence. */
export type LocalVoiceOptions = { url: string; startRms?: number; endRms?: number };
export function createLocalVoiceProvider(options: LocalVoiceOptions & {id:string;name:string}): AgentVoiceProvider {
  const name=options.name;
  const url = new URL(options.url);
  if (!isVoiceWebSocket(url)) throw new Error(`${name} voice requires a loopback or same-origin secure WebSocket host.`);
  return { id: options.id, name, async open(owner) {
    owner.signal.throwIfAborted();
    const socket = new WebSocket(url); socket.binaryType = "arraybuffer";
    let seq = 0, response: { seq: number; id: string } | undefined, blocked = false, closed = false;
    let lastResponseId: string | undefined;
    let closing: Promise<void> | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    let readyResolve: (() => void) | undefined, readyReject: ((error: Error) => void) | undefined;
    let closeResolve: (() => void) | undefined;
    const gone = new Promise<void>((resolve) => { closeResolve = resolve; });
    const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    const send = (value: Record<string, unknown>) => {
      if (socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > 256 * 1024) throw new Error(`${name} voice transport is unavailable or backlogged.`);
      socket.send(JSON.stringify(value));
    };
    const emit: typeof owner.emit = (event) => { if (!closed && !owner.signal.aborted) owner.emit(event); };
    const stopLocal = () => {
      blocked = true;
      const id = response?.id ?? lastResponseId;
      if (id) emit({ type: "response-interrupted", responseId: id });
      lastResponseId = undefined;
      response = undefined; emit({ type: "activity", activity: "listening" });
    };
    const fail = (error: Error) => {
      if (closed) return;
      readyReject?.(error); emit({ type: "ended", error: error.message }); void close();
    };
    const gate = createSpeechGate({
      ...(options.startRms === undefined ? {} : { startRms: options.startRms }),
      ...(options.endRms === undefined ? {} : { endRms: options.endRms }),
      start() {
        stopLocal(); seq++; blocked = false;
        send({ type: "input/start", seq });
      },
      frame(samples) {
        if (socket.bufferedAmount > 256 * 1024) throw new Error(`${name} microphone transport is backlogged.`);
        const bytes = new ArrayBuffer(3840), view = new DataView(bytes);
        samples.forEach((value, index) => view.setFloat32(index * 4, value, true));
        socket.send(bytes);
      },
      end(valid) { send({ type: valid ? "input/commit" : "input/cancel", seq }); },
    });
    function close(): Promise<void> {
      if (closing) return closing;
      closed = true; clearTimeout(timer); gate.close(); owner.signal.removeEventListener("abort", onAbort);
      readyReject?.(new Error(`${name} voice connection cancelled.`));
      closing = Promise.resolve().then(async () => {
        if (socket.readyState === WebSocket.OPEN) {
          try { send({ type: "voice/close" }); } catch {}
        } else socket.close();
        const limit = setTimeout(() => { socket.close(); closeResolve?.(); }, 10000);
        try { await gone; } finally { clearTimeout(limit); socket.close(); }
      });
      return closing;
    }
    const onAbort = () => { void close(); };
    owner.signal.addEventListener("abort", onAbort, { once: true });
    socket.addEventListener("open", () => { if (closed) socket.close(); else send({ type: "voice/open" }); });
    socket.addEventListener("message", (event) => {
      if (closed) { try { if (typeof event.data === "string" && JSON.parse(event.data).type === "voice/closed") socket.close(); } catch {} return; }
      try {
        if (event.data instanceof ArrayBuffer) {
          if (event.data.byteLength !== 3844) throw new Error(`Invalid ${name} PCM frame.`);
          const view = new DataView(event.data), token = view.getUint32(0, true);
          if (!response || blocked || token !== seq || token !== response.seq) return;
          const samples = Array.from({ length: 960 }, (_, i) => view.getFloat32(4 + i * 4, true));
          if (samples.some((value) => !Number.isFinite(value) || Math.abs(value) > 1)) throw new Error(`Invalid ${name} output samples.`);
          emit({ type: "audio", responseId: response.id, samples }); return;
        }
        if (typeof event.data !== "string" || event.data.length > 65536) throw new Error(`Invalid ${name} voice message.`);
        const item = JSON.parse(event.data);
        if (item.type === "voice/ready") { readyResolve?.(); return; }
        if (item.type === "voice/closed") { socket.close(); return; }
        if (item.type === "error") { fail(new Error(String(item.message))); return; }
        if (item.seq !== seq || blocked) return;
        if (item.type === "response-started" && typeof item.responseId === "string") {
          response = { seq, id: item.responseId }; lastResponseId = response.id;
          emit({ type: "response-started", responseId: response.id });
        } else if (item.type === "response-ended" && response) {
          emit({ type: "response-ended", responseId: response.id }); response = undefined;
        } else if (item.type === "transcript" && (item.speaker === "user" || item.speaker === "assistant") && typeof item.text === "string") {
          emit({ type: "transcript", id: `${owner.id}:${seq}:${item.speaker}`, speaker: item.speaker, text: item.text });
        } else if (item.type === "activity" && ["thinking", "listening"].includes(item.activity)) {
          emit({ type: "activity", activity: item.activity });
        }
      } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
    });
    socket.addEventListener("close", () => { closeResolve?.(); if (!closed) fail(new Error(`Local ${name} voice connection closed.`)); });
    socket.addEventListener("error", () => fail(new Error(`Could not connect to local ${name} voice.`)));
    const startupTimeout = setTimeout(() => fail(new Error(`${name} voice startup timed out.`)), 20000);
    try { await ready; owner.signal.throwIfAborted(); }
    catch (error) { await close(); throw error; }
    finally { clearTimeout(startupTimeout); }
    emit({ type: "activity", activity: "listening" });
    return {
      input(samples) {
        if (closed) return;
        if (samples.length !== 960 || samples.some((n) => !Number.isFinite(n) || Math.abs(n) > 1)) throw new Error("Invalid microphone PCM.");
        gate.input(samples);
        clearTimeout(timer);
        timer = setTimeout(() => { if (!closed) { try { gate.flush(); } catch (error) { fail(error as Error); } } }, 750);
      },
      interrupt() { if (!closed) { gate.close(); clearTimeout(timer); stopLocal(); send({ type: "voice/interrupt", seq }); } },
      close,
    };
  } };
}
