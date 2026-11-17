import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { createAgentHuddle } from "huddle-lab/agent-voice";
import { deferred } from "./helpers.mjs";

const frame = (value = 0.25) => new Array(960).fill(value);
function fixture(t, overrides = {}) {
  const contexts = [], captures = [], audios = [], connections = [];
  const provider = {
    id: "test-provider", name: "Test provider (not a model)",
    open: mock.fn(async (context) => {
      contexts.push(context);
      const connection = { input: mock.fn(async () => {}), interrupt: mock.fn(async () => {}), close: mock.fn(async () => {}) };
      connections.push(connection);
      return connection;
    }), ...overrides.provider,
  };
  const huddle = createAgentHuddle({
    provider,
    openAudio: async (capture, ended, signal) => {
      captures.push({ capture, ended, signal });
      const audio = { mute: mock.fn(), play: mock.fn(), participants: mock.fn(), close: mock.fn() };
      audios.push(audio); return audio;
    }, ...overrides, provider,
  });
  t.after(() => huddle.dispose());
  return { huddle, provider, contexts, captures, audios, connections };
}
const response = (context, responseId = "r1", samples = frame()) => {
  context.emit({ type: "response-started", responseId });
  context.emit({ type: "audio", responseId, samples });
};
function waitPhase(huddle, phase) {
  if (huddle.snapshot().phase === phase) return Promise.resolve();
  return new Promise((resolve) => {
    const off = huddle.subscribe(() => { if (huddle.snapshot().phase === phase) { off(); resolve(); } });
  });
}

test("one user microphone feeds the supplied AI pipe; response PCM returns to playback", async (t) => {
  const h = fixture(t);
  await h.huddle.start();
  assert.equal(h.huddle.snapshot().phase, "connected");
  assert.equal(h.huddle.snapshot().activity, "listening");
  h.captures[0].capture(frame());
  assert.deepEqual(h.connections[0].input.mock.calls[0].arguments[0], frame());
  response(h.contexts[0]);
  assert.equal(h.audios[0].play.mock.calls[0].arguments[0], "agent:test-provider");
  assert.deepEqual(h.audios[0].play.mock.calls[0].arguments[1], frame());
  assert.equal(h.huddle.snapshot().activity, "speaking");
  h.contexts[0].emit({ type: "response-ended", responseId: "r1" });
  assert.equal(h.huddle.snapshot().activity, "listening");
  await h.huddle.leave();
  assert.equal(h.connections[0].close.mock.callCount(), 1);
  assert.equal(h.audios[0].close.mock.callCount(), 1);
});

test("provider owns thinking/response lifecycle; snapshots are stable and immutable", async (t) => {
  const h = fixture(t);
  await h.huddle.start();
  h.contexts[0].emit({ type: "activity", activity: "thinking" });
  assert.equal(h.huddle.snapshot().activity, "thinking");
  assert.equal(h.huddle.snapshot(), h.huddle.snapshot());
  assert.throws(() => { h.huddle.snapshot().agent.name = "changed"; }, TypeError);
  h.contexts[0].emit({ type: "activity", activity: "listening" });
  assert.equal(h.huddle.snapshot().activity, "listening");
});

test("mute blocks user input while allowing AI output", async (t) => {
  const h = fixture(t);
  await h.huddle.start();
  h.huddle.mute();
  h.captures[0].capture(frame());
  response(h.contexts[0]);
  assert.equal(h.connections[0].input.mock.callCount(), 0);
  assert.equal(h.audios[0].play.mock.callCount(), 1);
  assert.equal(h.huddle.snapshot().muted, true);
  h.huddle.mute();
  h.captures[0].capture(frame());
  assert.equal(h.connections[0].input.mock.callCount(), 1);
});

test("interrupt clears scheduled AI audio, cancels the response and ignores its late frames", async (t) => {
  const h = fixture(t);
  await h.huddle.start();
  response(h.contexts[0]);
  await h.huddle.interrupt();
  assert.equal(h.connections[0].interrupt.mock.calls[0].arguments[0], "r1");
  assert.deepEqual(h.audios[0].participants.mock.calls.at(-2).arguments[0], ["local-user"]);
  h.contexts[0].emit({ type: "audio", responseId: "r1", samples: frame() });
  h.contexts[0].emit({ type: "response-started", responseId: "r1" });
  assert.equal(h.audios[0].play.mock.callCount(), 1);
  assert.equal(h.huddle.snapshot().activity, "listening");
  response(h.contexts[0], "r2");
  h.contexts[0].emit({ type: "audio", responseId: "r1", samples: frame() });
  assert.equal(h.audios[0].play.mock.callCount(), 2);
});

test("provider speech-detection interruption uses the same playback fence", async (t) => {
  const h = fixture(t);
  await h.huddle.start();
  response(h.contexts[0]);
  h.contexts[0].emit({ type: "response-interrupted", responseId: "r1" });
  h.contexts[0].emit({ type: "audio", responseId: "r1", samples: frame() });
  assert.equal(h.huddle.snapshot().activity, "listening");
  assert.equal(h.audios[0].play.mock.callCount(), 1);
  assert.equal(h.connections[0].interrupt.mock.callCount(), 0);
});

test("final user/assistant transcripts are bounded, immutable and deduplicated", async (t) => {
  const h = fixture(t);
  await h.huddle.start();
  const emit = h.contexts[0].emit;
  emit({ type: "transcript", id: "user-1", speaker: "user", text: "A final user line" });
  emit({ type: "transcript", id: "user-1", speaker: "user", text: "duplicate" });
  assert.equal(h.huddle.snapshot().transcripts.length, 1);
  assert.throws(() => { h.huddle.snapshot().transcripts[0].text = "changed"; }, TypeError);
  for (let i = 0; i < 205; i++) emit({ type: "transcript", id: `assistant-${i}`, speaker: "assistant", text: `Line ${i}` });
  assert.equal(h.huddle.snapshot().transcripts.length, 200);
  assert.equal(h.huddle.snapshot().transcripts[0].id, "assistant-5");
  await h.huddle.leave();
  assert.equal(h.huddle.snapshot().transcripts.length, 200);
  await h.huddle.start();
  assert.equal(h.huddle.snapshot().transcripts.length, 0);
});

test("stale response transcripts and callbacks from an earlier call never enter the new one", async (t) => {
  const h = fixture(t);
  await h.huddle.start();
  const old = h.contexts[0];
  response(old);
  await h.huddle.interrupt();
  old.emit({ type: "transcript", id: "old", responseId: "r1", speaker: "assistant", text: "cancelled" });
  assert.equal(h.huddle.snapshot().transcripts.length, 0);
  await h.huddle.leave();
  await h.huddle.start();
  old.emit({ type: "ended", error: "old failure" });
  old.emit({ type: "transcript", id: "old-user", speaker: "user", text: "old call" });
  response(old, "late");
  assert.equal(h.huddle.snapshot().phase, "connected");
  assert.equal(h.huddle.snapshot().transcripts.length, 0);
  assert.equal(h.audios[1].play.mock.callCount(), 0);
});

test("cancelled opening stays reserved, releases the mic immediately and closes the late AI handle once", async (t) => {
  const started = deferred(), gate = deferred(), close = mock.fn(async () => {});
  let context;
  const h = fixture(t, { provider: { open: mock.fn(async (seat) => {
    context = seat; started.resolve(); await gate.promise;
    return { input() {}, interrupt() {}, close };
  }) } });
  const starting = h.huddle.start();
  await started.promise;
  const leaving = h.huddle.leave();
  assert.equal(context.signal.aborted, true);
  assert.equal(h.audios[0].close.mock.callCount(), 1);
  assert.equal(h.huddle.snapshot().phase, "leaving");
  await h.huddle.start();
  assert.equal(h.provider.open.mock.callCount(), 1);
  response(context);
  gate.resolve();
  await Promise.all([starting, leaving]);
  assert.equal(close.mock.callCount(), 1);
  assert.equal(h.huddle.snapshot().phase, "idle");
});

test("closing provider work remains reserved and ignores outgoing audio until settled", async (t) => {
  const closing = deferred(), gate = deferred();
  const h = fixture(t);
  await h.huddle.start();
  h.connections[0].close.mock.mockImplementation(async () => { closing.resolve(); await gate.promise; });
  const leaving = h.huddle.leave();
  await closing.promise;
  response(h.contexts[0]);
  await h.huddle.start();
  assert.equal(h.provider.open.mock.callCount(), 1);
  assert.equal(h.audios[0].play.mock.callCount(), 0);
  gate.resolve();
  await leaving;
  await h.huddle.start();
  assert.equal(h.provider.open.mock.callCount(), 2);
});

test("a late microphone from a cancelled start cannot replace the new call's playback owner", async (t) => {
  const requested = deferred(), gate = deferred();
  const oldAudio = { close: mock.fn(), participants: mock.fn() };
  const newAudio = { close: mock.fn(), participants: mock.fn(), play: mock.fn(), mute: mock.fn() };
  let opens = 0;
  const h = fixture(t, { openAudio: async () => {
    if (++opens === 1) { requested.resolve(); await gate.promise; return oldAudio; }
    return newAudio;
  } });
  const oldStart = h.huddle.start();
  await requested.promise;
  await h.huddle.leave();
  await h.huddle.start();
  gate.resolve(); await oldStart;
  response(h.contexts[0]);
  await h.huddle.interrupt();
  assert.equal(oldAudio.close.mock.callCount(), 1);
  assert.ok(newAudio.participants.mock.callCount() > 1);
  assert.equal(oldAudio.participants.mock.callCount(), 0);
});

test("pre-connection output is bounded to the latest four frames and then played", async (t) => {
  const h = fixture(t, { provider: { open: mock.fn(async (context) => {
    context.emit({ type: "response-started", responseId: "greeting" });
    for (let i = 0; i < 6; i++) context.emit({ type: "audio", responseId: "greeting", samples: frame(i / 10) });
    context.emit({ type: "response-ended", responseId: "greeting" });
    return { input() {}, interrupt() {}, close() {} };
  }) } });
  await h.huddle.start();
  assert.deepEqual(h.audios[0].play.mock.calls.map((call) => call.arguments[1][0]), [0.2, 0.3, 0.4, 0.5]);
});

test("invalid AI PCM terminates the pipe and releases both sides", async (t) => {
  const h = fixture(t);
  await h.huddle.start();
  const failed = waitPhase(h.huddle, "error");
  response(h.contexts[0], "bad", [NaN]);
  await failed;
  assert.match(h.huddle.snapshot().error, /960 finite/);
  assert.equal(h.connections[0].close.mock.callCount(), 1);
  assert.equal(h.audios[0].close.mock.callCount(), 1);
});

test("provider input/interrupt failures use normal call cleanup", async (t) => {
  for (const operation of ["input", "interrupt"]) {
    const h = fixture(t);
    await h.huddle.start();
    const failed = waitPhase(h.huddle, "error");
    h.connections[0][operation].mock.mockImplementation(async () => { throw new Error(`${operation} failed`); });
    if (operation === "input") h.captures[0].capture(frame());
    else await h.huddle.interrupt();
    await failed;
    assert.equal(h.connections[0].close.mock.callCount(), 1);
  }
});

test("opening and cleanup failures are visible and allow a later explicit retry", async (t) => {
  const h = fixture(t);
  h.provider.open.mock.mockImplementationOnce(async () => { throw new Error("Provider offline"); });
  await h.huddle.start();
  assert.equal(h.huddle.snapshot().error, "Provider offline");
  await h.huddle.start();
  h.connections[0].close.mock.mockImplementation(async () => { throw new Error("Provider close failed"); });
  await h.huddle.leave();
  assert.equal(h.huddle.snapshot().error, "Provider close failed");
  await h.huddle.start();
  assert.equal(h.huddle.snapshot().phase, "connected");
});

test("host abort and disposal stop provider callbacks and prevent new sessions", async (t) => {
  const session = new AbortController(), h = fixture(t, { signal: session.signal });
  await h.huddle.start();
  const failed = waitPhase(h.huddle, "error");
  session.abort(new Error("Host signed out"));
  await failed;
  assert.equal(h.contexts[0].signal.aborted, true);
  assert.equal(h.connections[0].close.mock.callCount(), 1);
  await h.huddle.dispose();
  await h.huddle.start();
  assert.equal(h.provider.open.mock.callCount(), 1);
});
