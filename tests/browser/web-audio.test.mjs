// Browser-only evidence: real AudioWorklet loading/rendering, microphone PCM,
// buffer playback and track/context shutdown. Synthetic devices, no real mic.
import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { chromium } from "playwright";
import { serveDemo } from "../../scripts/serve-demo.mjs";

let browser, host;
before(async () => {
  host = await serveDemo(0);
  browser = await chromium.launch({
    channel: process.env.HUDDLE_BROWSER_CHANNEL ?? "chrome", headless: true,
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
  });
});
after(async () => {
  await browser?.close();
  if (host) await new Promise((resolve, reject) => {
    host.server.close((error) => error ? reject(error) : resolve());
    host.server.closeAllConnections();
  });
});

async function pageFor(t) {
  const context = await browser.newContext({ permissions: ["microphone"] });
  t.after(() => context.close());
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  t.after(() => assert.deepEqual(pageErrors, []));
  await page.goto(host.url);
  // Observe native APIs without replacing their audio implementation.
  await page.evaluate(() => {
    const probe = window.probe = { contexts: [], tracks: [], worklets: [], raw: 0, frames: [], played: 0, ended: 0 };
    const NativeContext = AudioContext, NativeWorklet = AudioWorkletNode;
    window.AudioContext = class extends NativeContext {
      constructor(...args) {
        super(...args);
        probe.contexts.push(this);
        const create = this.createBufferSource.bind(this);
        this.createBufferSource = () => {
          const source = create();
          source.addEventListener("ended", () => probe.played++);
          return source;
        };
      }
    };
    window.AudioWorkletNode = class extends NativeWorklet {
      constructor(...args) {
        super(...args);
        probe.worklets.push(this);
        this.port.addEventListener("message", () => probe.raw++);
        this.port.start();
      }
    };
    const acquire = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (...args) => {
      const stream = await acquire(...args);
      probe.tracks.push(...stream.getTracks());
      return stream;
    };
  });
  return page;
}

test("native worklet capture, mute, audible-buffer rendering and abort cleanup", { timeout: 20000 }, async (t) => {
  const page = await pageFor(t);
  await page.evaluate(async () => {
    const { openWebAudio } = await import("/dist/web-audio/index.js");
    window.abortAudio = new AbortController();
    window.audio = await openWebAudio(
      (samples) => probe.frames.push(samples), () => probe.ended++, abortAudio.signal,
    );
  });
  await page.waitForFunction(() => probe.frames.length >= 3);
  const format = await page.evaluate(() => ({
    sampleRate: probe.contexts[0].sampleRate,
    lengths: [...new Set(probe.frames.map((frame) => frame.length))],
    finite: probe.frames.every((frame) => frame.every(Number.isFinite)),
  }));
  assert.deepEqual(format, { sampleRate: 48000, lengths: [960], finite: true });
  await page.evaluate(() => {
    audio.mute(true);
    probe.baseline = probe.frames.length;
    probe.barrier = probe.raw + 5;
  });
  // Rendering continues through five actual worklet messages while capture is gated.
  await page.waitForFunction(() => probe.raw >= probe.barrier);
  assert.equal(await page.evaluate(() => probe.frames.length === probe.baseline), true);
  assert.equal(await page.evaluate(() => probe.tracks[0].enabled), false);
  await page.evaluate(() => audio.play("peer", Array.from({ length: 4800 }, (_, index) => Math.sin(index * 2 * Math.PI * 440 / 48000) * 0.1)));
  await page.waitForFunction(() => probe.played >= 1);
  await page.evaluate(() => audio.mute(false));
  await page.waitForFunction(() => probe.frames.length > probe.baseline);
  await page.evaluate(() => abortAudio.abort());
  await page.waitForFunction(() => probe.contexts.every((context) => context.state === "closed"));
  assert.equal(await page.evaluate(() => probe.tracks.every((track) => track.readyState === "ended")), true);
  assert.equal(await page.evaluate(() => probe.ended), 0);
});

test("local demo wires core controls to actual browser capture and releases repeated calls", { timeout: 20000 }, async (t) => {
  const page = await pageFor(t);
  for (let call = 0; call < 2; call++) {
    await page.getByRole("button", { name: "마이크 시작", exact: true }).click();
    await page.waitForFunction(() => document.getElementById("status").textContent === "연결됨" && Number(document.getElementById("frames").textContent) > 0);
    const played = await page.evaluate(() => probe.played);
    await page.getByRole("button", { name: "재생 테스트", exact: true }).click();
    await page.waitForFunction((baseline) => probe.played > baseline, played);
    await page.getByRole("button", { name: "음소거", exact: true }).click();
    assert.equal(await page.getByRole("button", { name: "음소거 해제", exact: true }).getAttribute("aria-pressed"), "true");
    await page.getByRole("button", { name: "종료", exact: true }).click();
    await page.waitForFunction(() => document.getElementById("status").textContent === "대기 중" && probe.contexts.every((context) => context.state === "closed"));
    assert.equal(await page.evaluate(() => probe.tracks.every((track) => track.readyState === "ended")), true);
    assert.equal(await page.locator("#error").textContent(), "");
  }
});

test("a native microphone grant arriving after cancellation is stopped", { timeout: 20000 }, async (t) => {
  const page = await pageFor(t);
  await page.evaluate(() => {
    const acquire = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (...args) => {
      const stream = await acquire(...args);
      probe.acquired = true;
      await new Promise((resolve) => { probe.release = resolve; });
      return stream;
    };
    window.abortAudio = new AbortController();
    window.openResult = import("/dist/web-audio/index.js").then(({ openWebAudio }) =>
      openWebAudio(() => {}, () => {}, abortAudio.signal)).then(() => "opened", (error) => error.name);
  });
  await page.waitForFunction(() => probe.acquired === true);
  await page.evaluate(() => { abortAudio.abort(); probe.release(); });
  assert.equal(await page.evaluate(() => openResult), "AbortError");
  await page.waitForFunction(() => probe.contexts.every((context) => context.state === "closed"));
  assert.equal(await page.evaluate(() => probe.tracks.every((track) => track.readyState === "ended")), true);
  assert.equal(await page.evaluate(() => probe.worklets.length), 0);
});

test("a real worklet URL failure closes the already-acquired native microphone", { timeout: 20000 }, async (t) => {
  const page = await pageFor(t);
  const result = await page.evaluate(async () => {
    const { createWebAudioAdapter } = await import("/dist/web-audio/index.js");
    try {
      await createWebAudioAdapter({ workletUrl: "/missing-worklet.js" })(() => {}, () => {}, new AbortController().signal);
      return "opened";
    } catch (error) { return error.name; }
  });
  assert.notEqual(result, "opened");
  await page.waitForFunction(() => probe.contexts.every((context) => context.state === "closed"));
  assert.equal(await page.evaluate(() => probe.tracks.length > 0 && probe.tracks.every((track) => track.readyState === "ended")), true);
});
