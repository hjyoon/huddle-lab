import assert from "node:assert/strict";
import { test } from "node:test";
import {
  huddleDescription, huddleParent, huddleRoom, isHuddleRoom, huddleLifecycle,
  recentHuddles, discoverHuddles,
} from "huddle-lab";
import { event, parent, room, viewer, peer, authority, stranger } from "./helpers.mjs";

test("parent markers and malformed room IDs follow the upstream format", () => {
  assert.equal(huddleParent(huddleDescription(parent)), parent);
  assert.equal(isHuddleRoom(huddleDescription(parent)), true);
  for (const description of [undefined, "plain chat", huddleDescription("invalid"), `${huddleDescription(parent)}\nextra`])
    assert.equal(huddleParent(description), undefined);
  for (const content of ["{", "null", "{}", '{"ephemeral_channel_id":1}', '{"ephemeral_channel_id":"invalid"}'])
    assert.equal(huddleRoom({ content }), undefined);
  assert.equal(huddleRoom(event(48100)), room);
});

test("discovery accepts creator/relay ends and ignores unrelated or premature ends", () => {
  const start = event(48100);
  assert.equal(recentHuddles([start, event(48103, stranger, 12)], parent, authority, 20).length, 1);
  assert.equal(recentHuddles([start, event(48103, viewer, 9)], parent, authority, 20).length, 1);
  for (const ender of [viewer, authority])
    assert.deepEqual(recentHuddles([event(48103, ender, 12), start], parent, authority, 20), []);
  assert.deepEqual(recentHuddles([start], "other-parent", authority, 20), []);
});

test("discovery excludes expired/future starts, malformed content and parent-as-room", () => {
  const start = event(48100, viewer, 100);
  assert.deepEqual(recentHuddles([start], parent, authority, 99), []);
  assert.equal(recentHuddles([start], parent, authority, 3699).length, 1);
  assert.deepEqual(recentHuddles([start], parent, authority, 3700), []);
  for (const content of ["{", "null", JSON.stringify({ ephemeral_channel_id: parent })])
    assert.deepEqual(recentHuddles([{ ...start, content }], parent, authority, 101), []);
});

test("canonical earliest start owns a room; newest live rooms are offered first", () => {
  const secondRoom = "00000000-0000-4000-8000-000000000003";
  const starts = [event(48100, stranger, 15), event(48100, viewer, 10), event(48100, peer, 12, {
    content: JSON.stringify({ ephemeral_channel_id: secondRoom }),
  })];
  assert.deepEqual(recentHuddles([...starts, event(48103, stranger, 16)], parent, authority, 20), [
    { id: secondRoom, creator: peer, startedAt: 12 },
    { id: room, creator: viewer, startedAt: 10 },
  ]);
});

test("discovery forwards bounded queries and abort to the host", async () => {
  const abort = new AbortController();
  let received;
  const source = {
    relayAuthor: authority,
    async read(filters, options) { received = { filters, options }; return []; },
  };
  assert.deepEqual(await discoverHuddles(source, parent, abort.signal), []);
  assert.deepEqual(received.filters, [
    { kinds: [48100], "#h": [parent], limit: 30 },
    { kinds: [48103], "#h": [parent], limit: 100 },
  ]);
  assert.equal(received.options.signal, abort.signal);
  assert.equal(received.options.fresh, true);
});

test("participation history trusts only relay notices and ignores pre-start activity", () => {
  const joined = (pubkey, at, member = peer) => event(48101, pubkey, at, { tags: [["h", parent], ["p", member]] });
  const records = [joined(authority, 9), event(48100), joined(stranger, 11), joined(authority, 12)];
  assert.deepEqual(huddleLifecycle(records, room, parent, authority), {
    startedAt: 10, endedAt: undefined, participants: [peer],
  });
  assert.deepEqual(huddleLifecycle([...records, event(48102, authority, 13, {
    tags: [["h", parent], ["p", peer]],
  })], room, parent, authority).participants, []);
  assert.deepEqual(huddleLifecycle(records, room, "other-parent", authority).participants, []);
});

test("untrusted ends do not stop history; activity after a trusted end is ignored", () => {
  const records = [event(48100), event(48103, stranger, 11), event(48103, authority, 12),
    event(48101, authority, 13, { tags: [["h", parent], ["p", peer]] })];
  assert.deepEqual(huddleLifecycle(records, room, parent, authority), {
    startedAt: 10, endedAt: 12, participants: [],
  });
});
