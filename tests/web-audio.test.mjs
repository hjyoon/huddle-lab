import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { openWebAudio, createWebAudioAdapter } from "huddle-lab/web-audio";
import { deferred } from "./helpers.mjs";
import { audioHarness } from "./web-audio-helpers.mjs";

test("Web Audio uses 48 kHz capture, the packaged worklet and the default speaker", async (t) => {
  const h = audioHarness(t);
  const send = mock.fn(), ended = mock.fn();
  const audio = await openWebAudio(send, ended, new AbortController().signal);
  t.after(() => audio.close());
  assert.deepEqual(h.contexts.mock.calls[0].arguments[0], { sampleRate: 48000, latencyHint: "interactive" });
  assert.deepEqual(h.media.getUserMedia.mock.calls[0].arguments[0], { audio: {
    channelCount: 1, sampleRate: 48000, echoCancellation: true, noiseSuppression: true, autoGainControl: true,
  } });
  assert.match(h.context.audioWorklet.addModule.mock.calls[0].arguments[0], /capture\.worklet\.js$/);
  assert.equal(h.worklets[0].args[1], "buzz-huddle-capture");
  assert.equal(h.output.connect.mock.calls[0].arguments[0], h.context.destination);
  h.worklets[0].port.onmessage({ data: new Float32Array(960).fill(0.25) });
  assert.equal(send.mock.callCount(), 1);
  assert.equal(send.mock.calls[0].arguments[0].length, 960);
  assert.equal(ended.mock.callCount(), 0);
});

test("custom worklet URL works without a bundler-specific import", async (t) => {
  const h = audioHarness(t);
  const audio = await createWebAudioAdapter({ workletUrl: "/assets/capture.js" })(mock.fn(), mock.fn(), new AbortController().signal);
  audio.close();
  assert.equal(h.context.audioWorklet.addModule.mock.calls[0].arguments[0], "/assets/capture.js");
});

test("mute disables the microphone and gates capture while reception remains active", async (t) => {
  const h = audioHarness(t);
  const send = mock.fn();
  const audio = await openWebAudio(send, mock.fn(), new AbortController().signal);
  t.after(() => audio.close());
  audio.mute(true);
  h.worklets[0].port.onmessage({ data: new Float32Array(960) });
  audio.play("peer", new Array(480).fill(0.25));
  assert.equal(h.track.enabled, false);
  assert.equal(send.mock.callCount(), 0);
  assert.equal(h.buffers.length, 1);
  audio.mute(false);
  h.worklets[0].port.onmessage({ data: new Float32Array(960) });
  assert.equal(h.track.enabled, true);
  assert.equal(send.mock.callCount(), 1);
});

test("close/abort are idempotent, release all resources and silence late callbacks", async (t) => {
  const h = audioHarness(t);
  const send = mock.fn(), ended = mock.fn(), abort = new AbortController();
  const audio = await openWebAudio(send, ended, abort.signal);
  audio.play("peer", new Array(480).fill(0.25));
  const lateCapture = h.worklets[0].port.onmessage;
  abort.abort();
  audio.close();
  lateCapture({ data: new Float32Array(960) });
  audio.play("peer", [1]);
  audio.mute(false);
  assert.equal(h.track.stop.mock.callCount(), 1);
  assert.equal(h.sources[0].disconnect.mock.callCount(), 1);
  assert.equal(h.worklets[0].port.close.mock.callCount(), 1);
  assert.equal(h.worklets[0].disconnect.mock.callCount(), 1);
  assert.equal(h.buffers[0].stop.mock.callCount(), 1);
  assert.equal(h.context.close.mock.callCount(), 1);
  assert.equal(send.mock.callCount(), 0);
  assert.equal(ended.mock.callCount(), 0);
});

test("an already aborted call allocates no audio resources", async (t) => {
  const h = audioHarness(t);
  await assert.rejects(openWebAudio(mock.fn(), mock.fn(), AbortSignal.abort()), { name: "AbortError" });
  assert.equal(h.contexts.mock.callCount(), 0);
  assert.equal(h.media.getUserMedia.mock.callCount(), 0);
});

test("unsupported media and denied microphone permission fail with cleanup", async (t) => {
  const h = audioHarness(t);
  h.media.getUserMedia.mock.mockImplementation(async () => { throw new Error("Permission denied"); });
  await assert.rejects(openWebAudio(mock.fn(), mock.fn(), new AbortController().signal), /Permission denied/);
  assert.equal(h.context.close.mock.callCount(), 1);
  h.stub("navigator", {});
  await assert.rejects(openWebAudio(mock.fn(), mock.fn(), new AbortController().signal), /HTTPS or localhost/);
  assert.equal(h.contexts.mock.callCount(), 1);
});

test("cancel during microphone acquisition releases a late stream without creating a source", async (t) => {
  const h = audioHarness(t), started = deferred(), gate = deferred();
  h.media.getUserMedia.mock.mockImplementation(async () => { started.resolve(); return gate.promise; });
  const abort = new AbortController();
  const opening = openWebAudio(mock.fn(), mock.fn(), abort.signal);
  const rejected = assert.rejects(opening, { name: "AbortError" });
  await started.promise;
  abort.abort();
  gate.resolve(h.stream);
  await rejected;
  assert.equal(h.track.stop.mock.callCount(), 1);
  assert.equal(h.context.createMediaStreamSource.mock.callCount(), 0);
  assert.equal(h.context.close.mock.callCount(), 1);
});

test("cancel during context resume never requests the microphone", async (t) => {
  const h = audioHarness(t), started = deferred(), gate = deferred();
  h.context.resume.mock.mockImplementation(async () => { started.resolve(); await gate.promise; });
  const abort = new AbortController();
  const opening = openWebAudio(mock.fn(), mock.fn(), abort.signal);
  const rejected = assert.rejects(opening, { name: "AbortError" });
  await started.promise;
  abort.abort();
  gate.resolve();
  await rejected;
  assert.equal(h.media.getUserMedia.mock.callCount(), 0);
});

test("cancel during worklet loading never attaches the released microphone", async (t) => {
  const h = audioHarness(t), started = deferred(), gate = deferred();
  h.context.audioWorklet.addModule.mock.mockImplementation(async () => { started.resolve(); await gate.promise; });
  const abort = new AbortController();
  const opening = openWebAudio(mock.fn(), mock.fn(), abort.signal);
  const rejected = assert.rejects(opening, { name: "AbortError" });
  await started.promise;
  abort.abort();
  gate.resolve();
  await rejected;
  assert.equal(h.track.stop.mock.callCount(), 1);
  assert.equal(h.worklets.length, 0);
});

test("worklet load and graph setup failures release acquired tracks", async (t) => {
  for (const failAt of ["worklet", "source"]) {
    const h = audioHarness(t);
    if (failAt === "worklet") h.context.audioWorklet.addModule.mock.mockImplementation(async () => { throw new Error("Module missing"); });
    else h.context.createMediaStreamSource.mock.mockImplementation(() => { throw new Error("Source failed"); });
    await assert.rejects(openWebAudio(mock.fn(), mock.fn(), new AbortController().signal));
    assert.equal(h.track.stop.mock.callCount(), 1);
    assert.equal(h.context.close.mock.callCount(), 1);
    if (failAt === "source") assert.equal(h.worklets[0].port.close.mock.callCount(), 1);
  }
});

test("an unsupported sample rate is rejected before microphone access", async (t) => {
  const h = audioHarness(t);
  h.context.sampleRate = 44100;
  await assert.rejects(openWebAudio(mock.fn(), mock.fn(), new AbortController().signal), /48 kHz/);
  assert.equal(h.media.getUserMedia.mock.callCount(), 0);
  assert.equal(h.context.close.mock.callCount(), 1);
});

test("an ended microphone or processor failure releases capture and reports one unexpected end", async (t) => {
  for (const failure of ["track", "processor"]) {
    const h = audioHarness(t), ended = mock.fn();
    const audio = await openWebAudio(mock.fn(), ended, new AbortController().signal);
    const end = failure === "track" ? h.track.onended : h.worklets[0].onprocessorerror;
    end();
    end();
    audio.close();
    assert.equal(ended.mock.callCount(), 1);
    assert.equal(h.track.stop.mock.callCount(), 1);
    assert.equal(h.context.close.mock.callCount(), 1);
  }
});

test("a microphone that ends while the module loads rejects opening", async (t) => {
  const h = audioHarness(t), started = deferred(), gate = deferred(), ended = mock.fn();
  h.context.audioWorklet.addModule.mock.mockImplementation(async () => { started.resolve(); await gate.promise; });
  const opening = openWebAudio(mock.fn(), ended, new AbortController().signal);
  const rejected = assert.rejects(opening, { name: "AbortError" });
  await started.promise;
  h.track.onended();
  gate.resolve();
  await rejected;
  assert.equal(ended.mock.callCount(), 1);
  assert.equal(h.worklets.length, 0);
});

test("participant removal stops only its buffers and a returning peer starts afresh", async (t) => {
  const h = audioHarness(t);
  const audio = await openWebAudio(mock.fn(), mock.fn(), new AbortController().signal);
  t.after(() => audio.close());
  audio.play("one", [0.25]);
  audio.play("two", [0.25]);
  audio.participants(["two"]);
  assert.equal(h.buffers[0].stop.mock.callCount(), 1);
  assert.equal(h.buffers[1].stop.mock.callCount(), 0);
  h.context.currentTime = 1;
  audio.play("one", [0.25]);
  assert.equal(h.buffers[2].start.mock.calls[0].arguments[0], 1.06);
});

test("invalid incoming PCM never allocates playback buffers", async (t) => {
  const h = audioHarness(t);
  const audio = await openWebAudio(mock.fn(), mock.fn(), new AbortController().signal);
  for (const samples of [[], [NaN], [Infinity], new Array(5761).fill(0)]) audio.play("peer", samples);
  assert.equal(h.buffers.length, 0);
  audio.close();
});
