import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { harness, deferred, waitPhase, destination, room, viewer, peer } from "./helpers.mjs";

test("start discovers before capture and joins the latest supplied room", async (t) => {
  const h = harness({ discover: mock.fn(async () => [{ id: room, creator: peer, startedAt: 10 }]) });
  t.after(() => h.huddle.dispose());
  const phases = [];
  h.huddle.subscribe(() => phases.push(h.huddle.snapshot().phase));
  await h.huddle.start(destination);
  assert.equal(h.options.discover.mock.callCount(), 1);
  assert.equal(h.options.authorize.mock.callCount(), 2);
  assert.equal(h.bridge.open.mock.calls[0].arguments[2], room);
  assert.equal(h.huddle.snapshot().phase, "connected");
  assert.deepEqual(h.huddle.snapshot().participants, [viewer, peer]);
  assert.deepEqual(phases, ["connecting", "connecting", "connected"]);
  await h.huddle.leave();
  assert.equal(h.state.signal.aborted, true);
  assert.equal(h.audio.close.mock.callCount(), 1);
  assert.equal(h.bridge.close.mock.calls[0].arguments[0], "call-1");
  assert.equal(h.huddle.snapshot().phase, "idle");
});

test("no discovered candidate delegates new-room creation to the transport", async (t) => {
  const h = harness();
  t.after(() => h.huddle.dispose());
  await h.huddle.start(destination);
  assert.equal(h.bridge.open.mock.calls[0].arguments[2], undefined);
  assert.equal(h.huddle.snapshot().room, room);
});

test("explicit join skips discovery; duplicate joins never open another call", async (t) => {
  const h = harness();
  t.after(() => h.huddle.dispose());
  await h.huddle.join(destination, room);
  await h.huddle.start(destination);
  assert.equal(h.options.discover.mock.callCount(), 0);
  assert.equal(h.bridge.open.mock.callCount(), 1);
});

test("unavailable transport and denied access never request a microphone", async (t) => {
  for (const overrides of [
    { bridge: { available: false } },
    { authorize: async () => { throw new Error("Access denied"); } },
  ]) {
    const h = harness(overrides);
    t.after(() => h.huddle.dispose());
    await h.huddle.start(destination);
    assert.equal(h.huddle.snapshot().phase, "error");
    assert.equal(h.options.openAudio.mock.callCount(), 0);
    assert.equal(h.bridge.open.mock.callCount(), 0);
  }
});

test("microphone failure reports an error without opening a transport", async (t) => {
  const h = harness({ openAudio: async () => { throw new Error("Permission denied"); } });
  t.after(() => h.huddle.dispose());
  await h.huddle.start(destination);
  assert.equal(h.huddle.snapshot().error, "Permission denied");
  assert.equal(h.bridge.open.mock.callCount(), 0);
});

test("cancel during discovery ignores its late result without capturing", async (t) => {
  const started = deferred(), gate = deferred();
  const h = harness({ discover: async () => { started.resolve(); return gate.promise; } });
  t.after(() => h.huddle.dispose());
  const joining = h.huddle.start(destination);
  await started.promise;
  await h.huddle.leave();
  gate.resolve([{ id: room, creator: peer, startedAt: 10 }]);
  await joining;
  assert.equal(h.huddle.snapshot().phase, "idle");
  assert.equal(h.options.openAudio.mock.callCount(), 0);
});

test("cancel releases a late microphone grant and never opens a socket", async (t) => {
  const started = deferred(), gate = deferred();
  const lateAudio = { close: mock.fn() };
  let signal;
  const h = harness({ openAudio: async (_send, _ended, value) => {
    signal = value; started.resolve(); await gate.promise; return lateAudio;
  } });
  t.after(() => h.huddle.dispose());
  const joining = h.huddle.start(destination);
  await started.promise;
  await h.huddle.leave();
  assert.equal(signal.aborted, true);
  gate.resolve();
  await joining;
  assert.equal(lateAudio.close.mock.callCount(), 1);
  assert.equal(h.bridge.open.mock.callCount(), 0);
});

test("cancel during native open closes the exact call after it settles", async (t) => {
  const started = deferred(), gate = deferred();
  let receive;
  const h = harness({ bridge: { open: async (_id, _d, _room, listener) => {
    receive = listener; started.resolve(); await gate.promise;
    listener({ type: "connected", room, participants: [peer] });
  } } });
  t.after(() => h.huddle.dispose());
  const joining = h.huddle.start(destination);
  await started.promise;
  const closing = h.huddle.leave();
  assert.equal(h.huddle.snapshot().phase, "leaving");
  await h.huddle.start(destination);
  gate.resolve();
  await Promise.all([joining, closing]);
  receive({ type: "participants", participants: [peer] });
  assert.equal(h.huddle.snapshot().phase, "idle");
  assert.equal(h.bridge.close.mock.calls[0].arguments[0], "call-1");
  assert.equal(h.audio.close.mock.callCount(), 1);
});

test("mute suppresses microphone frames, clears queued audio and preserves reception", async (t) => {
  const gate = deferred();
  const h = harness({ bridge: { send: mock.fn(() => gate.promise) } });
  t.after(() => h.huddle.dispose());
  await h.huddle.join(destination, room);
  h.state.capture([1]);
  h.state.capture([2]);
  h.huddle.mute();
  h.state.capture([3]);
  h.state.receive({ type: "audio", peer, samples: [0.5] });
  assert.equal(h.huddle.snapshot().muted, true);
  assert.equal(h.audio.play.mock.callCount(), 1);
  gate.resolve();
  // Await the submitted send; its drain resumes before this await completes.
  await gate.promise;
  assert.equal(h.bridge.send.mock.callCount(), 1);
  h.huddle.mute();
  h.state.capture([4]);
  assert.equal(h.bridge.send.mock.callCount(), 2);
  assert.deepEqual(h.audio.mute.mock.calls.map((call) => call.arguments[0]), [true, false]);
});

test("roster keeps arrival order, deduplicates devices and drops departed audio", async (t) => {
  const h = harness();
  t.after(() => h.huddle.dispose());
  await h.huddle.join(destination, room);
  h.state.receive({ type: "participants", participants: [peer, viewer, peer] });
  assert.deepEqual(h.huddle.snapshot().participants, [viewer, peer]);
  h.state.receive({ type: "participants", participants: [] });
  h.state.receive({ type: "audio", peer, samples: [1] });
  assert.deepEqual(h.huddle.snapshot().participants, [viewer]);
  assert.equal(h.audio.play.mock.callCount(), 0);
});

test("session invalidation releases capture and ignores stale events after a new call", async (t) => {
  const h = harness();
  t.after(() => h.huddle.dispose());
  await h.huddle.join(destination, room);
  const stale = h.state.receive;
  await h.huddle.invalidate("Session changed");
  assert.equal(h.huddle.snapshot().error, "Session changed");
  await h.huddle.join(destination, room);
  stale({ type: "ended", error: "old call" });
  assert.equal(h.huddle.snapshot().phase, "connected");
  assert.equal(h.huddle.snapshot().id, "call-2");
});

test("remote end and microphone disconnect use the same cleanup path", async (t) => {
  for (const end of [
    (h) => h.state.receive({ type: "ended", error: "Socket disconnected" }),
    (h) => h.state.micEnded(),
  ]) {
    const h = harness();
    t.after(() => h.huddle.dispose());
    await h.huddle.join(destination, room);
    const ended = waitPhase(h.huddle, "error");
    end(h);
    await ended;
    assert.equal(h.audio.close.mock.callCount(), 1);
    assert.equal(h.bridge.close.mock.callCount(), 1);
  }
});

test("opening failure closes audio and transport, and allows manual retry", async (t) => {
  const h = harness({ bridge: { open: mock.fn(async () => { throw new Error("Admission denied"); }) } });
  t.after(() => h.huddle.dispose());
  await h.huddle.join(destination, room);
  assert.equal(h.huddle.snapshot().error, "Admission denied");
  assert.equal(h.bridge.close.mock.callCount(), 1);
  assert.equal(h.audio.close.mock.callCount(), 1);
  await h.huddle.join(destination, room);
  assert.equal(h.bridge.open.mock.callCount(), 2);
});

test("cleanup failure is visible, releases the barrier and permits retry", async (t) => {
  const h = harness({ bridge: { close: async () => { throw new Error("Close failed"); } } });
  t.after(() => h.huddle.dispose());
  await h.huddle.join(destination, room);
  await h.huddle.leave();
  assert.equal(h.huddle.snapshot().error, "Close failed");
  await h.huddle.join(destination, room);
  assert.equal(h.huddle.snapshot().phase, "connected");
});

test("dispose is idempotent and permanently prevents new calls", async () => {
  const h = harness();
  await h.huddle.join(destination, room);
  await Promise.all([h.huddle.dispose(), h.huddle.dispose()]);
  await h.huddle.join(destination, room);
  assert.equal(h.bridge.open.mock.callCount(), 1);
  assert.equal(h.bridge.close.mock.callCount(), 1);
  assert.equal(h.huddle.snapshot().phase, "idle");
});

test("public snapshots and destination copies cannot be mutated", async (t) => {
  const h = harness();
  t.after(() => h.huddle.dispose());
  const mutable = { ...destination };
  await h.huddle.join(mutable, room);
  mutable.viewer = peer;
  assert.equal(h.huddle.snapshot().destination.viewer, viewer);
  assert.throws(() => { h.huddle.snapshot().phase = "idle"; }, TypeError);
  assert.throws(() => h.huddle.snapshot().participants.push("other"), TypeError);
});

test("heartbeat uses the call ID, stops on leave and fails closed on host error", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const h = harness();
  t.after(() => h.huddle.dispose());
  await h.huddle.join(destination, room);
  t.mock.timers.tick(5000);
  assert.equal(h.bridge.touch.mock.calls[0].arguments[0], "call-1");
  await h.huddle.leave();
  t.mock.timers.tick(10000);
  assert.equal(h.bridge.touch.mock.callCount(), 1);
  await h.huddle.join(destination, room);
  h.bridge.touch = async () => { throw new Error("Lease lost"); };
  const ended = waitPhase(h.huddle, "error");
  t.mock.timers.tick(5000);
  await ended;
  assert.equal(h.huddle.snapshot().error, "Lease lost");
  assert.equal(h.audio.close.mock.callCount(), 2);
});

test("transport audio failure cleans up instead of retaining an active call", async (t) => {
  const h = harness({ bridge: { send: async () => { throw new Error("Send failed"); } } });
  t.after(() => h.huddle.dispose());
  await h.huddle.join(destination, room);
  const ended = waitPhase(h.huddle, "error");
  h.state.capture(new Array(960).fill(0));
  await ended;
  assert.equal(h.huddle.snapshot().error, "Send failed");
  assert.equal(h.bridge.close.mock.callCount(), 1);
});

test("open completion is distinct from admission; no audio is sent before connected", async (t) => {
  let receive;
  const h = harness({ bridge: { open: async (_id, _d, _r, listener) => { receive = listener; } } });
  t.after(() => h.huddle.dispose());
  await h.huddle.join(destination, room);
  assert.equal(h.huddle.snapshot().phase, "connecting");
  h.state.capture([1]);
  assert.equal(h.bridge.send.mock.callCount(), 0);
  receive({ type: "connected", room, participants: [] });
  h.state.capture([2]);
  assert.equal(h.bridge.send.mock.callCount(), 1);
});

test("a synchronous end during open does not deadlock the close barrier", async (t) => {
  const h = harness({ bridge: { open: async (_id, _d, _r, receive) => {
    receive({ type: "ended", error: "Rejected" });
  } } });
  t.after(() => h.huddle.dispose());
  const ended = waitPhase(h.huddle, "error");
  await h.huddle.join(destination, room);
  await ended;
  assert.equal(h.huddle.snapshot().error, "Rejected");
  assert.equal(h.bridge.close.mock.callCount(), 1);
});

test("dispose during authorization ignores late completion and never captures", async () => {
  const started = deferred(), gate = deferred();
  const h = harness({ authorize: async () => { started.resolve(); await gate.promise; } });
  const joining = h.huddle.join(destination, room);
  await started.promise;
  await h.huddle.dispose();
  gate.resolve();
  await joining;
  assert.equal(h.options.openAudio.mock.callCount(), 0);
  assert.equal(h.bridge.open.mock.callCount(), 0);
});

test("host session revocation cancels a pending microphone before transport opening", async (t) => {
  const started = deferred(), gate = deferred(), session = new AbortController();
  const lateAudio = { close: mock.fn() };
  let captureSignal;
  const h = harness({ signal: session.signal, openAudio: async (_send, _ended, signal) => {
    captureSignal = signal; started.resolve(); await gate.promise; return lateAudio;
  } });
  t.after(() => h.huddle.dispose());
  const joining = h.huddle.start(destination);
  await started.promise;
  const ended = waitPhase(h.huddle, "error");
  session.abort(new Error("Signed out"));
  await ended;
  assert.equal(captureSignal.aborted, true);
  gate.resolve();
  await joining;
  assert.equal(lateAudio.close.mock.callCount(), 1);
  await h.huddle.start(destination);
  assert.equal(h.bridge.open.mock.callCount(), 0);
  assert.equal(h.huddle.snapshot().error, "Signed out");
});
