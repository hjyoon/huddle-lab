import assert from "node:assert/strict";
import { test } from "node:test";
import { createPlayout } from "../dist/web-audio/playout.js";
import { audioHarness } from "./web-audio-helpers.mjs";

test("playback is contiguous through near misses and recovers from a true underrun", (t) => {
  const h = audioHarness(t), playout = createPlayout(h.context, h.output, 0.06);
  playout.play(new Array(480).fill(0.25));
  assert.equal(h.buffers[0].start.mock.calls[0].arguments[0], 0.06);
  h.context.currentTime = 0.065;
  playout.play(new Array(480).fill(0.25));
  assert.ok(Math.abs(h.buffers[1].start.mock.calls[0].arguments[0] - 0.07) < 1e-9);
  h.context.currentTime = 0.1;
  playout.play(new Array(480).fill(0.25));
  assert.ok(Math.abs(h.buffers[2].start.mock.calls[0].arguments[0] - 0.12) < 1e-9);
  playout.close();
});

test("playback backlog is bounded to a 200ms start horizon and resumes as it drains", (t) => {
  const h = audioHarness(t), playout = createPlayout(h.context, h.output, 0.06);
  const frame = new Array(4800).fill(0.25);
  playout.play(frame);
  playout.play(frame);
  playout.play(frame);
  assert.equal(h.buffers.length, 2);
  h.context.currentTime = 0.1;
  playout.play(frame);
  assert.equal(h.buffers.length, 3);
  assert.ok(Math.abs(h.buffers[2].start.mock.calls[0].arguments[0] - 0.26) < 1e-9);
  playout.close();
  playout.close();
  playout.play(frame);
  assert.equal(h.buffers.length, 3);
  assert.ok(h.buffers.every((buffer) => buffer.stop.mock.callCount() === 1));
});

test("completed buffers disconnect and are not stopped a second time", (t) => {
  const h = audioHarness(t), playout = createPlayout(h.context, h.output, 0.06);
  playout.play([0.25]);
  h.buffers[0].onended();
  playout.close();
  assert.equal(h.buffers[0].disconnect.mock.callCount(), 1);
  assert.equal(h.buffers[0].stop.mock.callCount(), 0);
});
