// Real browser Opus + real loopback HTTP/WS authentication and forwarding.
// Both microphones are synthetic; no external community or user key is used.
import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { chromium } from "playwright";
import { localRelay } from "../fixtures/relay.mjs";

let browser, relay;
before(async () => {
  relay = await localRelay({ demo: true });
  browser = await chromium.launch({ channel: process.env.HUDDLE_BROWSER_CHANNEL ?? "chrome", headless: true,
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
});
after(async () => { await browser?.close(); await relay?.close(); });

async function pageFor(t, index = 0) {
  const context = await browser.newContext({ permissions: ["microphone"] });
  t.after(() => context.close());
  const page = await context.newPage(), errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.goto(relay.url);
  await page.addScriptTag({ type: "importmap", content: JSON.stringify({ imports: {
    "@noble/curves/": "/vendor/@noble/curves/", "@noble/hashes/": "/vendor/@noble/hashes/",
  } }) });
  await page.exposeFunction("hostSignEvent", (event) => relay.identities[index].signEvent(event));
  return page;
}

test("browser WebCodecs produces Opus packets and decodes finite 48 kHz mono PCM", { timeout: 20000 }, async (t) => {
  const page = await pageFor(t);
  const result = await page.evaluate(async () => {
    const { createWebCodecsCodec } = await import("/dist/webcodecs/index.js");
    const packets = [];
    let enough, failure;
    const ready = new Promise((resolve, reject) => { enough = resolve; failure = reject; });
    const codec = await createWebCodecsCodec((packet) => { packets.push(packet); if (packets.length >= 2) enough(); }, failure);
    try {
      const sizes = [], lengths = [];
      let energy = 0;
      for (let frame = 0; frame < 4; frame++) {
        const pcm = Array.from({ length: 960 }, (_, index) => Math.sin((frame * 960 + index) * 2 * Math.PI * 440 / 48000) * 0.25);
        codec.encode(pcm);
      }
      await ready;
      for (const packet of [...packets]) {
        const decoded = await codec.decode(1, packet);
        sizes.push(packet.length); lengths.push(decoded.length);
        if (!decoded.every(Number.isFinite)) throw new Error("non-finite decoded sample");
        energy += decoded.reduce((sum, sample) => sum + sample * sample, 0);
      }
      return { sizes, lengths, energy };
    } finally { codec.close(); }
  });
  assert.ok(result.sizes.every((size) => size > 0 && size < 4000));
  assert.ok(result.lengths.every((length) => length === 960));
  assert.ok(result.energy > 1);
});

test("two browser callers authenticate, exchange Opus audio, mute and leave independently", { timeout: 30000 }, async (t) => {
  const a = await pageFor(t, 0), b = await pageFor(t, 1);
  const start = async (page, index) => {
    await page.evaluate(async ({ destination, relayPubkey }) => {
      const [{ createHuddles }, { createRelayAdapter }, { createWebCodecsCodec }, { openWebAudio }] = await Promise.all([
        import("/dist/index.js"), import("/dist/relay/index.js"), import("/dist/webcodecs/index.js"), import("/dist/web-audio/index.js"),
      ]);
      window.probe = { captured: 0, received: 0, invalid: false, tracks: [], contexts: [] };
      const NativeContext = AudioContext;
      window.AudioContext = class extends NativeContext { constructor(...args) { super(...args); probe.contexts.push(this); } };
      const acquire = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async (...args) => {
        const stream = await acquire(...args); probe.tracks.push(...stream.getTracks()); return stream;
      };
      window.adapter = createRelayAdapter({ relayUrl: destination.relayUrl, relayPubkey, scope: destination.scope,
        identity: { pubkey: destination.viewer, signEvent: (event) => window.hostSignEvent(event) }, createCodec: createWebCodecsCodec });
      window.huddle = createHuddles({ ...adapter, openAudio: async (send, ended, signal) => {
        const audio = await openWebAudio((samples) => { probe.captured++; send(samples); }, ended, signal);
        return { ...audio, play(peer, samples) {
          probe.received++;
          if (samples.length !== 480 || !samples.every(Number.isFinite)) probe.invalid = true;
          audio.play(peer, samples);
        } };
      } });
      await huddle.start(destination);
      if (huddle.snapshot().phase !== "connected") throw new Error(huddle.snapshot().error ?? "not connected");
    }, { destination: relay.destination(relay.identities[index]), relayPubkey: relay.authority.pubkey });
  };
  await start(a, 0);
  await start(b, 1);
  for (const page of [a, b]) {
    await page.waitForFunction(() => huddle.snapshot().participants.length === 2 && probe.captured > 0 && probe.received > 0);
    assert.equal(await page.evaluate(() => probe.invalid), false);
  }
  assert.ok(relay.state.forwardedAudio > 0);
  await b.evaluate(() => huddle.mute());
  assert.equal(await b.evaluate(() => huddle.snapshot().muted && probe.tracks.every((track) => !track.enabled)), true);
  await b.evaluate(async () => { await huddle.leave(); await adapter.dispose(); });
  await b.waitForFunction(() => probe.contexts.every((context) => context.state === "closed"));
  await a.waitForFunction(() => huddle.snapshot().participants.length === 1);
  assert.equal(await a.evaluate(() => huddle.snapshot().phase), "connected");
  await a.evaluate(async () => { await huddle.dispose(); await adapter.dispose(); });
  await a.waitForFunction(() => probe.contexts.every((context) => context.state === "closed"));
  for (const page of [a, b]) assert.equal(await page.evaluate(() => probe.tracks.every((track) => track.readyState === "ended")), true);
});

test("local two-user demo connects through its host signer and forwards browser audio", { timeout: 30000 }, async (t) => {
  const contextA = await browser.newContext({ permissions: ["microphone"] });
  const contextB = await browser.newContext({ permissions: ["microphone"] });
  t.after(async () => { await contextA.close(); await contextB.close(); });
  const a = await contextA.newPage(), b = await contextB.newPage(), errors = [];
  for (const page of [a, b]) page.on("pageerror", (error) => errors.push(error.message));
  await a.goto(`${relay.url}/examples/browser/relay.html?peer=0`);
  await b.goto(`${relay.url}/examples/browser/relay.html?peer=1`);
  for (const page of [a, b]) {
    await page.getByRole("button", { name: "통화 시작", exact: true }).click();
    await page.waitForFunction(() => document.getElementById("status").textContent === "연결됨");
  }
  for (const page of [a, b]) await page.waitForFunction(() =>
    document.getElementById("participants").textContent === "2" && Number(document.getElementById("received").textContent) > 0);
  await b.getByRole("button", { name: "음소거", exact: true }).click();
  assert.equal(await b.getByRole("button", { name: "음소거 해제", exact: true }).getAttribute("aria-pressed"), "true");
  await b.getByRole("button", { name: "종료", exact: true }).click();
  await a.waitForFunction(() => document.getElementById("participants").textContent === "1");
  assert.equal(await a.locator("#status").textContent(), "연결됨");
  await a.getByRole("button", { name: "종료", exact: true }).click();
  for (const page of [a, b]) {
    await page.waitForFunction(() => document.getElementById("status").textContent === "대기 중");
    assert.equal(await page.locator("#error").textContent(), "");
  }
  assert.deepEqual(errors, []);
});
