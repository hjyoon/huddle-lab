import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { createPcmSender } from "huddle-lab";
import { deferred } from "./helpers.mjs";

test("serial delivery retains the latest four waiting frames on overflow", async () => {
  const gate = deferred();
  const sent = [];
  const sender = createPcmSender(async (frame) => { sent.push(frame[0]); await gate.promise; },
    new AbortController().signal, assert.fail);
  const draining = sender.send([1]);
  for (let i = 2; i <= 7; i++) await sender.send([i]);
  assert.deepEqual(sent, [1]);
  gate.resolve();
  await draining;
  assert.deepEqual(sent, [1, 4, 5, 6, 7]);
});

test("clear discards waiting audio without retiring the sender", async () => {
  const gate = deferred();
  const sent = [];
  const sender = createPcmSender(async (frame) => { sent.push(frame[0]); await gate.promise; },
    new AbortController().signal, assert.fail);
  const draining = sender.send([1]);
  await sender.send([2]);
  sender.clear();
  gate.resolve();
  await draining;
  await sender.send([3]);
  assert.deepEqual(sent, [1, 3]);
});

test("send failure retires the queue and reports the original error once", async () => {
  const gate = deferred();
  const offline = new Error("offline");
  const send = mock.fn(async () => { await gate.promise; throw offline; });
  const failed = mock.fn();
  const sender = createPcmSender(send, new AbortController().signal, failed);
  const draining = sender.send([1]);
  await sender.send([2]);
  gate.resolve();
  await draining;
  await sender.send([3]);
  assert.equal(send.mock.callCount(), 1);
  assert.equal(failed.mock.callCount(), 1);
  assert.equal(failed.mock.calls[0].arguments[0], offline);
});

test("abort discards pending frames and ignores a late transport failure", async () => {
  const gate = deferred();
  const abort = new AbortController();
  const send = mock.fn(() => gate.promise);
  const failed = mock.fn();
  const sender = createPcmSender(send, abort.signal, failed);
  const draining = sender.send([1]);
  await sender.send([2]);
  abort.abort();
  gate.reject(new Error("late failure"));
  await draining;
  await sender.send([3]);
  assert.equal(send.mock.callCount(), 1);
  assert.equal(failed.mock.callCount(), 0);
});

test("an already aborted sender never submits audio", async () => {
  const send = mock.fn();
  const sender = createPcmSender(send, AbortSignal.abort(), assert.fail);
  await sender.send([1]);
  assert.equal(send.mock.callCount(), 0);
});
