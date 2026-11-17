import assert from "node:assert/strict";
import { test } from "node:test";
import { WebSocket } from "ws";
import { createHuddles } from "huddle-lab";
import { createRelayAdapter } from "huddle-lab/relay";
import { checkedEvent, signChecked } from "../dist/relay/auth.js";
import { encodeFrame, parseFrame, parsePeers } from "../dist/relay/protocol.js";
import { localRelay, keypair } from "./fixtures/relay.mjs";
import { deferred, waitPhase } from "./helpers.mjs";

// Transparent PCM codec isolates the control/transport contract. Real Opus is
// exercised separately in browser tests with WebCodecs, never claimed here.
const testCodec = async (output) => ({
  encode(samples) { output(new Uint8Array(Float32Array.from(samples).buffer)); },
  async decode(_peer, data) { return new Float32Array(Uint8Array.from(data).buffer); },
  remove() {}, close() {},
});
async function fixture(t, options = {}) {
  const relay = await localRelay(options), clients = [], huddles = [];
  t.after(async () => {
    for (const huddle of huddles) await huddle.dispose();
    for (const adapter of clients) await adapter.dispose();
    await relay.close();
  });
  const adapter = (identity = relay.identities[0], overrides = {}) => {
    const result = createRelayAdapter({ relayUrl: relay.url, relayPubkey: relay.authority.pubkey,
      scope: "local-relay-demo", identity, createCodec: testCodec,
      createSocket: (url, headers) => new WebSocket(url, { headers }), ...overrides });
    clients.push(result); return result;
  };
  const controller = (identity, overrides = {}) => {
    const audio = { mute() {}, participants() {}, play() {}, close() {} };
    const result = createHuddles({ ...adapter(identity, overrides), openAudio: async () => audio });
    huddles.push(result); return result;
  };
  return { relay, adapter, controller };
}

test("real signed HTTP creates a private room, announces it, and discovers it for a second caller", async (t) => {
  const { relay, controller } = await fixture(t);
  const a = controller(relay.identities[0]), b = controller(relay.identities[1]);
  await a.start(relay.destination(relay.identities[0]));
  assert.equal(a.snapshot().phase, "connected");
  const id = a.snapshot().room;
  await b.start(relay.destination(relay.identities[1]));
  assert.equal(b.snapshot().phase, "connected");
  assert.equal(b.snapshot().room, id);
  assert.equal(relay.rooms.size, 1);
  assert.deepEqual(relay.events.map((event) => event.kind), [9007, 48100, 9000]);
  const creation = relay.events[0];
  assert.ok(creation.tags.some(([key, value]) => key === "visibility" && value === "private"));
  assert.ok(creation.tags.some(([key, value]) => key === "ttl" && value === "3600"));
});

test("two authenticated sockets exchange v2 frames and update actual attendance", async (t) => {
  const { relay, adapter } = await fixture(t), a = adapter(relay.identities[0]), b = adapter(relay.identities[1]);
  const connected = deferred(), heard = deferred(), left = deferred();
  let room;
  await a.bridge.open("a", relay.destination(relay.identities[0]), undefined, (update) => {
    if (update.type === "connected") room = update.room;
    if (update.type === "participants" && update.participants.includes(relay.identities[1].pubkey)) connected.resolve();
    if (update.type === "participants" && !update.participants.includes(relay.identities[1].pubkey)) left.resolve();
  });
  await b.bridge.open("b", relay.destination(relay.identities[1]), room, (update) => {
    if (update.type === "audio") heard.resolve(update);
  });
  await connected.promise;
  await a.bridge.send("a", new Array(960).fill(0.25));
  const audio = await heard.promise;
  assert.equal(audio.peer, relay.identities[0].pubkey);
  assert.equal(audio.samples.length, 480);
  assert.ok(audio.samples.every((sample) => sample === 0.25));
  assert.equal(relay.state.forwardedAudio, 1);
  await b.bridge.close("b");
  await left.promise;
  await a.bridge.close("a");
});

test("wrong identity, session and relay URL are rejected before any request", async (t) => {
  const { relay, adapter } = await fixture(t), client = adapter();
  const base = relay.destination();
  for (const change of [{ viewer: keypair().pubkey }, { scope: "wrong" }, { relayUrl: "https://other.example.org" }])
    await assert.rejects(client.authorize({ ...base, ...change }, undefined, new AbortController().signal), /does not match/);
  assert.equal(relay.requests.length, 0);
});

test("late decode rejection after an index reassignment cannot reset the new peer", async (t) => {
  const { relay, adapter } = await fixture(t), a = adapter(relay.identities[0]);
  const gate = deferred(), started = deferred(), replacementStarted = deferred(), heard = deferred();
  let decoded = 0, removed = 0, room;
  const replacement = keypair().pubkey;
  const b = adapter(relay.identities[1], { createCodec: async (output) => ({
    encode(samples) { output(new Uint8Array(Float32Array.from(samples).buffer)); },
    async decode() {
      decoded++;
      if (decoded === 1) { started.resolve(); return gate.promise; }
      if (decoded === 2) replacementStarted.resolve();
      return new Float32Array(960).fill(0.5);
    },
    remove() { removed++; }, close() {},
  }) });
  await a.bridge.open("a", relay.destination(), undefined, (event) => { if (event.type === "connected") room = event.room; });
  await b.bridge.open("b", relay.destination(relay.identities[1]), room, (event) => {
    if (event.type === "audio" && event.peer === replacement && decoded >= 3) heard.resolve();
  });
  await a.bridge.send("a", new Array(960).fill(0.25));
  await started.promise;
  const target = [...relay.sockets].find(([, peer]) => peer.pubkey === relay.identities[1].pubkey)[0];
  target.send(JSON.stringify({ type: "roster", peers: [
    { peer_index: 0, pubkey: replacement }, { peer_index: 1, pubkey: relay.identities[1].pubkey },
  ] }));
  await a.bridge.send("a", new Array(960).fill(0.25));
  await replacementStarted.promise;
  gate.reject(new Error("old decoder closed"));
  await a.bridge.send("a", new Array(960).fill(0.25));
  await heard.promise;
  assert.equal(removed, 1);
});

test("federated communities require a header-capable host socket factory", async (t) => {
  const { relay, controller } = await fixture(t, { requireFi: true });
  const huddle = controller(relay.identities[0], {
    createSocket: undefined, authorization: async () => ({ header: "local-test-evidence" }),
  });
  await huddle.start(relay.destination());
  assert.equal(huddle.snapshot().phase, "error");
  assert.match(huddle.snapshot().error, /host socket factory/);
});

test("tampered signed rosters and incorrect pinned authority fail closed", async (t) => {
  const { relay, adapter } = await fixture(t);
  relay.state.tamperQuery = true;
  await assert.rejects(adapter().authorize(relay.destination(), undefined, new AbortController().signal), /signature/);
  relay.state.tamperQuery = false;
  await assert.rejects(adapter(undefined, { relayPubkey: keypair().pubkey }).authorize(relay.destination(), undefined, new AbortController().signal), /belong/);
});

test("a nonmember cannot cause microphone capture or create a room", async (t) => {
  const { relay, adapter } = await fixture(t), outsider = keypair();
  let captured = false;
  const huddle = createHuddles({ ...adapter(outsider), openAudio: async () => { captured = true; throw new Error("unexpected"); } });
  t.after(() => huddle.dispose());
  await huddle.start(relay.destination(outsider));
  assert.equal(huddle.snapshot().phase, "error");
  assert.equal(captured, false);
  assert.equal(relay.events.length, 0);
});

test("room-only invitations require the creator's exact signed parent proof", async (t) => {
  const { relay, controller, adapter } = await fixture(t), caller = controller(relay.identities[0]);
  await caller.start(relay.destination());
  const id = caller.snapshot().room, invited = relay.identities[1];
  relay.members.delete(invited.pubkey);
  relay.rooms.get(id).members.add(invited.pubkey);
  const client = adapter(invited);
  await client.authorize(relay.destination(invited), id, new AbortController().signal);
  relay.state.omitProof = true;
  await assert.rejects(client.authorize(relay.destination(invited), id, new AbortController().signal), /original conversation/);
});

test("an unconfirmed automatic audio admission never reports connected", async (t) => {
  const { relay, controller } = await fixture(t), a = controller(relay.identities[0]), b = controller(relay.identities[1]);
  await a.start(relay.destination());
  relay.state.omitConfirmation = true;
  await b.join(relay.destination(relay.identities[1]), a.snapshot().room);
  assert.equal(b.snapshot().phase, "error");
  assert.match(b.snapshot().error, /membership could not be confirmed/);
});

test("unacknowledged creation is archived once; an attempted announcement preserves the room", async (t) => {
  for (const kind of [9007, 48100]) {
    const { relay, controller } = await fixture(t);
    relay.state.wrongReceiptKind = kind;
    const huddle = controller(relay.identities[0]);
    await huddle.start(relay.destination());
    assert.equal(huddle.snapshot().phase, "error");
    assert.equal([...relay.rooms.values()][0].archived, kind === 9007);
    assert.equal(relay.events.filter((event) => event.kind === kind).length, 1);
    assert.equal(relay.events.filter((event) => event.kind === 9002).length, kind === 9007 ? 1 : 0);
  }
});

test("cancellation interrupts a noncooperative NIP-42 signer and closes its pending socket", async (t) => {
  const { relay, controller } = await fixture(t), gate = deferred(), started = deferred();
  const identity = relay.identities[0];
  const huddle = controller({ pubkey: identity.pubkey, async signEvent(event) {
    if (event.kind === 22242) { started.resolve(); await gate.promise; }
    return identity.signEvent(event);
  } });
  const opening = huddle.start(relay.destination());
  await started.promise;
  await huddle.leave();
  assert.equal(huddle.snapshot().phase, "idle");
  gate.resolve();
  await opening;
  assert.equal(relay.sockets.size, 0);
});

test("federated headers reach both REST and the audio upgrade; revocation ends the call", async (t) => {
  const { relay, controller } = await fixture(t, { requireFi: true }), revoked = new AbortController();
  const huddle = controller(relay.identities[0], {
    authorization: async () => ({ header: "local-test-evidence", signal: revoked.signal }),
  });
  await huddle.start(relay.destination());
  assert.equal(huddle.snapshot().phase, "connected");
  const ended = waitPhase(huddle, "error");
  revoked.abort(new Error("Sign-in changed"));
  await ended;
  assert.equal(huddle.snapshot().phase, "error");
});

test("expired authorization and rejected audio admission expose errors without retrying", async (t) => {
  const { relay, controller } = await fixture(t);
  const expired = controller(relay.identities[0], { authorization: async () => ({ expiresAt: Date.now() - 1 }) });
  await expired.start(relay.destination());
  assert.match(expired.snapshot().error, /expired/);
  relay.state.denyAudio = true;
  const denied = controller(relay.identities[0]);
  await denied.start(relay.destination());
  assert.equal(denied.snapshot().phase, "error");
  assert.equal(relay.rooms.size, 1);
});

test("a signer cannot substitute fields or reuse a previously verified mutated event", async () => {
  const identity = keypair(), template = { kind: 22242, created_at: 10, tags: [["relay", "wss://example.org"]], content: "" };
  const signed = await identity.signEvent(template);
  await checkedEvent(signed);
  signed.content = "changed";
  await assert.rejects(checkedEvent(signed), /signature/);
  await assert.rejects(signChecked({ pubkey: identity.pubkey, signEvent: (event) => identity.signEvent({ ...event, kind: 1 }) }, template), /changed/);
});

test("v2 golden byte layout, peer-prefix parsing and invalid rosters match upstream", () => {
  const frame = encodeFrame(new Uint8Array([0xf8, 0xff]), 0x0102, 0x03040506, -1);
  assert.deepEqual([...frame], [1, 2, 3, 4, 5, 6, 255, 1, 248, 255]);
  const parsed = parseFrame(new Uint8Array([7, ...frame]));
  assert.equal(parsed.index, 7);
  assert.equal(parsed.sequence, 0x0102);
  assert.equal(parsed.timestamp, 0x03040506);
  assert.equal(parseFrame(new Uint8Array(9)), undefined);
  const peer = { peer_index: 0, pubkey: "a".repeat(64) };
  assert.throws(() => parsePeers({ peers: [peer, peer] }), /Invalid/);
  assert.throws(() => parsePeers({ peers: [{ ...peer, peer_index: 256 }] }), /Invalid/);
});
