import { mock } from "node:test";
import { createHuddles } from "huddle-lab";

export const parent = "00000000-0000-4000-8000-000000000001";
export const room = "00000000-0000-4000-8000-000000000002";
export const viewer = "a".repeat(64);
export const peer = "b".repeat(64);
export const authority = "c".repeat(64);
export const stranger = "d".repeat(64);
export const destination = Object.freeze({
  scope: "test-session", viewer, relayUrl: "https://relay.example.org",
  channelId: parent, channelName: "Test",
});

export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export function event(kind, pubkey = viewer, at = 10, overrides = {}) {
  return {
    id: `${kind}-${pubkey}-${at}`, pubkey, kind, created_at: at,
    tags: [["h", parent]],
    content: JSON.stringify({ ephemeral_channel_id: room }), ...overrides,
  };
}

export function waitPhase(huddle, phase) {
  if (huddle.snapshot().phase === phase) return Promise.resolve();
  return new Promise((resolve) => {
    const off = huddle.subscribe(() => {
      if (huddle.snapshot().phase === phase) { off(); resolve(); }
    });
  });
}

export function harness(overrides = {}) {
  const state = {};
  const audio = {
    mute: mock.fn(), play: mock.fn(), participants: mock.fn(), close: mock.fn(),
  };
  const bridge = {
    available: true,
    open: mock.fn(async (_id, _destination, selectedRoom, receive) => {
      state.receive = receive;
      receive({ type: "connected", room: selectedRoom ?? room, participants: [peer] });
    }),
    close: mock.fn(async () => {}), touch: mock.fn(async () => {}),
    send: mock.fn(async () => {}), ...overrides.bridge,
  };
  const options = {
    bridge,
    authorize: mock.fn(async () => {}),
    discover: mock.fn(async () => []),
    openAudio: mock.fn(async (capture, ended, signal) => {
      Object.assign(state, { capture, micEnded: ended, signal });
      return audio;
    }),
    createId: (() => { let next = 0; return () => `call-${++next}`; })(),
    ...overrides, bridge,
  };
  return { huddle: createHuddles(options), options, bridge, audio, state };
}
