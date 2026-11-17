// Adapted from block/buzz-app v1.0.4 features/huddle/voice.ts voice-seat lifetime.
// Copyright 2026 Block, Inc. Apache-2.0; see LICENSE and NOTICE.
// Modified: one model-independent AI peer, direct microphone input, explicit
// response IDs for interruption, final transcripts, and no app/Relay membership.
import { createHuddles } from "../controller.js";
import type { HuddleSnapshot } from "../controller.js";
import type { HuddleAudio, HuddleBridge } from "../types.js";
import type { AgentActivity, AgentHuddleOptions, AgentTranscript, AgentVoiceConnection, AgentVoiceEvent } from "./types.js";
export type { AgentActivity, AgentHuddleOptions, AgentTranscript, AgentVoiceContext, AgentVoiceConnection, AgentVoiceEvent, AgentVoiceProvider } from "./types.js";

export type AgentHuddleSnapshot = Readonly<{
  phase: HuddleSnapshot["phase"];
  muted: boolean;
  activity: AgentActivity;
  agent: Readonly<{ id: string; name: string }>;
  transcripts: readonly AgentTranscript[];
  error?: string;
}>;
type Seat = {
  id: string;
  signal: AbortSignal;
  abort: AbortController;
  opening?: Promise<AgentVoiceConnection>;
  connection?: AgentVoiceConnection;
  closing?: Promise<void>;
  responseId?: string;
  responseDone: boolean;
  blocked: boolean;
  ready: boolean;
  pending: number[][];
};
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const validId = (id: string) => typeof id === "string" && id.length > 0 && id.length <= 1000;

/** One user + one AI provider. Reuses the call/audio owner; does not require a
 * Nostr identity or Relay. A real provider must be supplied explicitly. */
export function createAgentHuddle(options: AgentHuddleOptions) {
  const { provider } = options;
  if (!validId(provider.id) || !validId(provider.name) || typeof provider.open !== "function")
    throw new Error("An identified agent voice provider is required.");
  const agent = Object.freeze({ id: provider.id, name: provider.name });
  const viewer = "local-user", peer = `agent:${agent.id}`;
  let activity: AgentActivity = "idle";
  let transcripts: readonly AgentTranscript[] = Object.freeze([]);
  const transcriptIds = new Set<string>();
  let current: Seat | undefined;
  let playback: HuddleAudio | undefined;
  let disposed = false;
  const listeners = new Set<() => void>();
  let snapshot: AgentHuddleSnapshot = Object.freeze({ phase: "idle", muted: false, activity, agent, transcripts });
  const live = (seat: Seat) => !disposed && current === seat && !seat.signal.aborted;
  function publish() {
    const call = huddles.snapshot();
    snapshot = Object.freeze({ phase: call.phase, muted: call.muted,
      activity: call.phase === "connected" ? activity : "idle", agent, transcripts,
      ...(call.error === undefined ? {} : { error: call.error }) });
    for (const listener of listeners) listener();
  }
  function clearPlayback() {
    // Removing only the AI drops its scheduled buffers; the microphone stays live.
    playback?.participants([viewer]);
    playback?.participants([viewer, peer]);
  }
  function closeConnection(seat: Seat) {
    if (!seat.closing) seat.closing = Promise.resolve().then(() => seat.connection?.close());
    return seat.closing;
  }
  function stopResponse(seat: Seat) {
    seat.blocked = true; seat.pending.length = 0;
    clearPlayback(); activity = "listening";
  }
  const bridge: HuddleBridge = {
    available: true,
    async open(id, _destination, _room, receive, signal) {
      if (current) throw new Error("The previous AI voice session is still closing.");
      const abort = new AbortController();
      const combined = AbortSignal.any([abort.signal, ...(signal ? [signal] : []), ...(options.signal ? [options.signal] : [])]);
      combined.throwIfAborted();
      const seat: Seat = { id, abort, signal: combined, responseDone: false, blocked: false, ready: false, pending: [] };
      current = seat;
      activity = "listening";
      const emit = (event: AgentVoiceEvent) => {
        if (!live(seat)) return;
        try {
          if (event.type === "ended") {
            receive({ type: "ended", error: event.error ?? null });
            return;
          }
          if (event.type === "response-started") {
            if (!validId(event.responseId)) throw new Error("Invalid AI response ID.");
            if (seat.responseId === event.responseId) return;
            clearPlayback();
            seat.pending.length = 0;
            seat.responseId = event.responseId;
            seat.responseDone = false;
            seat.blocked = false;
            activity = "thinking";
          } else if (event.type === "audio") {
            if (seat.responseId !== event.responseId || seat.blocked || seat.responseDone) return;
            if (event.samples.length !== 960 || event.samples.some((value) => !Number.isFinite(value) || Math.abs(value) > 1))
              throw new Error("AI output requires 960 finite normalized PCM samples at 48 kHz.");
            activity = "speaking";
            const samples = Array.from(event.samples);
            if (seat.ready) receive({ type: "audio", peer, samples });
            else {
              if (seat.pending.length === 4) seat.pending.shift();
              seat.pending.push(samples);
            }
          } else if (event.type === "response-ended") {
            if (event.responseId !== seat.responseId || seat.blocked) return;
            seat.responseDone = true;
            activity = "listening";
          } else if (event.type === "response-interrupted") {
            if (event.responseId !== seat.responseId) return;
            stopResponse(seat);
          } else if (event.type === "activity") {
            if (event.activity !== "listening" && event.activity !== "thinking") throw new Error("Invalid AI activity.");
            if (!seat.responseId || seat.responseDone || seat.blocked) activity = event.activity;
          } else if (event.type === "transcript") {
            if (!validId(event.id) || !["user", "assistant"].includes(event.speaker) ||
              typeof event.text !== "string" || event.text.length > 16000 ||
              (event.responseId !== undefined && !validId(event.responseId))) throw new Error("Invalid final voice transcript.");
            if (event.speaker === "assistant" && event.responseId !== undefined &&
              (event.responseId !== seat.responseId || seat.blocked)) return;
            const key = `${event.speaker}:${event.id}`;
            if (transcriptIds.has(key) || !event.text.trim()) return;
            const row = Object.freeze({ id: event.id, speaker: event.speaker, text: event.text,
              ...(event.responseId === undefined ? {} : { responseId: event.responseId }) });
            transcriptIds.add(key);
            if (transcripts.length === 200) {
              const oldest = transcripts[0]!;
              transcriptIds.delete(`${oldest.speaker}:${oldest.id}`);
            }
            transcripts = Object.freeze([...transcripts.slice(-199), row]);
          }
          publish();
        } catch (error) { receive({ type: "ended", error: message(error) }); }
      };
      // Reserve before callbacks can run. Late opens are closed before releasing it.
      seat.opening = Promise.resolve().then(() => provider.open({ id, signal: combined, emit }));
      seat.connection = await seat.opening;
      if (!live(seat)) {
        await closeConnection(seat);
        combined.throwIfAborted();
        return;
      }
      if (typeof seat.connection.input !== "function" || typeof seat.connection.interrupt !== "function" || typeof seat.connection.close !== "function")
        throw new Error("AI provider returned an invalid voice connection.");
      receive({ type: "connected", room: id, participants: [viewer, peer] });
      seat.ready = true;
      for (const samples of seat.pending) receive({ type: "audio", peer, samples });
      seat.pending.length = 0;
      publish();
    },
    async close(id) {
      const seat = current;
      if (!seat || seat.id !== id) return;
      seat.abort.abort();
      seat.pending.length = 0;
      try {
        await seat.opening?.catch(() => {});
        await closeConnection(seat);
      } finally { if (current === seat) current = undefined; }
    },
    async touch(id) {
      if (!current || current.id !== id || current.signal.aborted) throw new Error("AI voice session ended.");
    },
    async send(id, samples) {
      const seat = current;
      if (!seat || seat.id !== id || !live(seat) || !seat.connection) throw new Error("AI voice session is unavailable.");
      if (samples.length !== 960 || samples.some((value) => !Number.isFinite(value) || Math.abs(value) > 1))
        throw new Error("Invalid microphone PCM.");
      await seat.connection.input(samples);
    },
  };
  const huddles = createHuddles({
    bridge,
    ...(options.signal ? { signal: options.signal } : {}),
    authorize: async (_destination, _room, signal) => { signal.throwIfAborted(); },
    discover: async () => [],
    openAudio: async (send, ended, signal) => {
      const audio = await options.openAudio(send, ended, signal);
      if (!signal.aborted) playback = audio;
      return {
        mute: (value) => audio.mute(value),
        play: (key, samples) => audio.play(key, samples),
        participants: (keys) => audio.participants(keys),
        close() { if (playback === audio) playback = undefined; audio.close(); },
      };
    },
  });
  const off = huddles.subscribe(publish);
  return {
    snapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async start() {
      if (disposed || !["idle", "error"].includes(huddles.snapshot().phase)) return;
      transcripts = Object.freeze([]); transcriptIds.clear(); activity = "idle";
      // Private metadata for the generic call controller; no Relay is contacted.
      await huddles.start({ scope: "agent-voice", viewer, relayUrl: "agent://local",
        channelId: agent.id, channelName: agent.name });
    },
    mute: huddles.mute,
    async interrupt() {
      const seat = current;
      if (!seat || !live(seat) || !seat.connection || huddles.snapshot().phase !== "connected") return;
      try {
        stopResponse(seat); publish();
        await seat.connection.interrupt(seat.responseId);
      } catch (error) { if (live(seat)) await huddles.invalidate(message(error)); }
    },
    leave: huddles.leave,
    async dispose() {
      disposed = true;
      await huddles.dispose();
      off(); listeners.clear();
    },
  };
}
export type AgentHuddle = ReturnType<typeof createAgentHuddle>;
