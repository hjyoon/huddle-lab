import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { test } from "node:test";

const code = await readFile(new URL("../dist/web-audio/capture.worklet.js", import.meta.url), "utf8");
function worklet() {
  let Processor;
  runInNewContext(code, {
    AudioWorkletProcessor: class {
      port = { messages: [], postMessage(frame) { this.messages.push(Array.from(frame)); } };
    },
    registerProcessor(name, type) { assert.equal(name, "buzz-huddle-capture"); Processor = type; },
  });
  return new Processor();
}

test("real worklet source assembles render quanta into independent 960-sample frames", () => {
  const processor = worklet();
  for (let i = 0; i < 15; i++) assert.equal(processor.process([[new Float32Array(128).fill(0.25)]]), true);
  assert.equal(processor.port.messages.length, 2);
  for (const frame of processor.port.messages) {
    assert.equal(frame.length, 960);
    assert.ok(frame.every((sample) => sample === 0.25));
  }
  assert.notEqual(processor.port.messages[0], processor.port.messages[1]);
});

test("worklet clips out-of-range samples and replaces non-finite input with silence", () => {
  const processor = worklet();
  const frame = new Float32Array(960);
  frame.set([2, -2, NaN, Infinity, -Infinity, 0.5]);
  processor.process([[frame]]);
  assert.deepEqual(processor.port.messages[0].slice(0, 6), [1, -1, 0, 0, 0, 0.5]);
});

test("missing microphone input keeps the processor alive without emitting frames", () => {
  const processor = worklet();
  assert.equal(processor.process([]), true);
  assert.equal(processor.process([[]]), true);
  assert.equal(processor.port.messages.length, 0);
});
