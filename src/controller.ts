// Adapted from block/buzz-app v1.0.4 (a1c9c96940d2a6c81fce9beed9b7cbcc34b144b8).
// Copyright 2026 Block, Inc. Apache-2.0; see LICENSE and NOTICE.
// Modified: injected host authorization/discovery/audio; removed app policies,
// incoming requests, agent seats, UI activity and automatic room archiving.
import { createPcmSender } from "./sender.js";
import type { HuddleRoom } from "./discovery.js";
import type {
  HuddleAudio, HuddleBridge, HuddleDestination, HuddleUpdate, OpenHuddleAudio,
} from "./types.js";

export type HuddleSnapshot = Readonly<{
  phase: "idle" | "connecting" | "connected" | "leaving" | "error";
  muted: boolean;
  participants: readonly string[];
  id?: string;
  destination?: HuddleDestination;
  room?: string;
  error?: string;
}>;

export type HuddleOptions = {
  bridge: HuddleBridge;
  openAudio: OpenHuddleAudio;
  /** Reject on invalid identity, community/session or channel access, before capture.
   * The bridge must still enforce actual admission on its trusted side. */
  authorize(destination: HuddleDestination, room: string | undefined, signal: AbortSignal): Promise<void>;
  discover(destination: HuddleDestination, signal: AbortSignal): Promise<readonly HuddleRoom[]>;
  createId?: () => string;
  /** Host session lifetime, including while microphone permission is pending. */
  signal?: AbortSignal;
};

type Attempt = {
  id: string;
  abort: AbortController;
  sender: ReturnType<typeof createPcmSender>;
  audio?: HuddleAudio;
  opening?: Promise<void>;
  heartbeat?: ReturnType<typeof setInterval>;
};
const idle = (): HuddleSnapshot => Object.freeze({
  phase: "idle", muted: false, participants: Object.freeze([]),
});
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** One human call per controller. The host owns identity changes and calls
 * invalidate() on access/session loss. UI unmount alone must not dispose it. */
export function createHuddles(options: HuddleOptions) {
  const { bridge, openAudio } = options;
  let snapshot = idle();
  let current: Attempt | undefined;
  let closing: Promise<void> | undefined;
  let disposed = false;
  const listeners = new Set<() => void>();
  const update = (next: HuddleSnapshot) => {
    snapshot = Object.freeze({ ...next, participants: Object.freeze([...next.participants]) });
    for (const listener of listeners) listener();
  };
  const valid = (attempt: Attempt) =>
    !disposed && current === attempt && !attempt.abort.signal.aborted;

  function leave(error?: string): Promise<void> {
    if (closing) return closing;
    const previous = current;
    current = undefined;
    if (!previous) {
      update(error === undefined ? idle() : { ...idle(), phase: "error", error });
      return Promise.resolve();
    }
    clearInterval(previous.heartbeat);
    previous.abort.abort();
    let failure = error;
    try { previous.audio?.close(); }
    catch (reason) { failure ??= message(reason); }
    // Install the close barrier before notifying listeners that can re-enter.
    closing = Promise.resolve().then(async () => {
      try {
        if (previous.opening) {
          await previous.opening.catch(() => {});
          await bridge.close(previous.id);
        }
      } catch (reason) {
        failure ??= message(reason);
      } finally {
        update(failure === undefined ? idle() : { ...idle(), phase: "error", error: failure });
        closing = undefined;
      }
    });
    update({ ...snapshot, phase: "leaving", participants: [] });
    return closing;
  }

  const invalidateSession = () => { void leave(message(options.signal?.reason ?? "Huddle session ended.")); };
  options.signal?.addEventListener("abort", invalidateSession, { once: true });

  async function join(destination: HuddleDestination, room?: string, discover = false) {
    if (disposed || current || closing) return;
    if (options.signal?.aborted) {
      invalidateSession();
      return;
    }
    if (!bridge.available) {
      update({ ...idle(), phase: "error", error: "Huddle transport is unavailable." });
      return;
    }
    // Copy caller-owned data so it cannot retarget an in-flight join.
    destination = Object.freeze({ ...destination });
    const id = (options.createId ?? (() => crypto.randomUUID()))();
    const abort = new AbortController();
    const attempt: Attempt = {
      id, abort,
      sender: createPcmSender(
        (samples) => bridge.send(id, samples), abort.signal,
        (reason) => { if (valid(attempt)) void leave(message(reason)); },
      ),
    };
    current = attempt;
    update({ ...idle(), phase: "connecting", id, destination, ...(room ? { room } : {}) });

    const receive = (event: HuddleUpdate) => {
      if (!valid(attempt)) return;
      if (event.type === "ended") {
        void leave(event.error ?? undefined);
      } else if (event.type === "audio") {
        if (snapshot.phase === "connected" && snapshot.participants.includes(event.peer))
          attempt.audio?.play(event.peer, event.samples);
      } else {
        const present = new Set([destination.viewer, ...event.participants]);
        const participants = snapshot.participants.filter((key) => present.has(key));
        for (const key of participants) present.delete(key);
        participants.push(...present);
        attempt.audio?.participants(participants);
        update({
          ...snapshot, participants,
          ...(event.type === "connected" ? { phase: "connected", room: event.room } : {}),
        });
      }
    };
    try {
      // Start always needs parent-chat authorization, including before discovery.
      await options.authorize(destination, room, abort.signal);
      if (!valid(attempt)) return;
      if (discover) {
        room = (await options.discover(destination, abort.signal))[0]?.id;
        if (!valid(attempt)) return;
        if (room) {
          await options.authorize(destination, room, abort.signal);
          if (!valid(attempt)) return;
          update({ ...snapshot, room });
        }
      }
      const audio = await openAudio(
        (samples) => {
          if (valid(attempt) && snapshot.phase === "connected" && !snapshot.muted)
            void attempt.sender.send(samples);
        },
        () => {
          if (valid(attempt)) void leave("The microphone disconnected. Join again to retry.");
        },
        abort.signal,
      );
      if (!valid(attempt)) { audio.close(); return; }
      attempt.audio = audio;
      attempt.opening = Promise.resolve().then(() => {
        if (valid(attempt)) return bridge.open(id, destination, room, receive, abort.signal);
      });
      await attempt.opening;
      if (valid(attempt)) {
        attempt.heartbeat = setInterval(() => {
          void bridge.touch(id).catch((reason) => {
            if (valid(attempt)) void leave(message(reason));
          });
        }, 5000);
      }
    } catch (reason) {
      if (valid(attempt)) await leave(message(reason));
    }
  }

  return {
    snapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    start: (destination: HuddleDestination) => join(destination, undefined, true),
    join: (destination: HuddleDestination, room: string) => join(destination, room),
    mute() {
      if (!current || snapshot.phase !== "connected") return;
      const muted = !snapshot.muted;
      try {
        if (muted) current.sender.clear();
        current.audio?.mute(muted);
        update({ ...snapshot, muted });
      } catch (reason) { void leave(message(reason)); }
    },
    leave: () => leave(),
    invalidate: (reason: string) => leave(reason),
    async dispose() {
      disposed = true;
      options.signal?.removeEventListener("abort", invalidateSession);
      await leave();
      listeners.clear();
    },
  };
}
export type Huddles = ReturnType<typeof createHuddles>;
