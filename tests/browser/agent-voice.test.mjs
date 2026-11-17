// Provider-neutral AI pipe + real Web Audio. The provider is a marked fixture;
// no inference, ASR, TTS or external API is represented by these tests.
import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { chromium } from "playwright";
import { serveDemo } from "../../scripts/serve-demo.mjs";

let browser, host;
before(async () => {
  host = await serveDemo(0, "/examples/browser/agent.html");
  browser = await chromium.launch({ channel: process.env.HUDDLE_BROWSER_CHANNEL ?? "chrome", headless: true,
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
});
after(async () => {
  await browser?.close();
  if (host) await new Promise((resolve) => { host.server.close(resolve); host.server.closeAllConnections(); });
});
async function pageFor(t) {
  const context = await browser.newContext({ permissions: ["microphone"] });
  t.after(() => context.close());
  const page = await context.newPage(), errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.goto(host.url);
  await page.evaluate(() => {
    const probe = window.probe = { contexts: [], tracks: [], buffers: 0, stopped: 0, captured: 0, interrupts: [], closed: 0 };
    const NativeContext = AudioContext;
    window.AudioContext = class extends NativeContext {
      constructor(...args) {
        super(...args); probe.contexts.push(this);
        const create = this.createBufferSource.bind(this);
        this.createBufferSource = () => {
          probe.buffers++;
          const source = create(), stop = source.stop.bind(source);
          source.stop = (...args) => { probe.stopped++; return stop(...args); };
          return source;
        };
      }
    };
    const acquire = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (...args) => {
      const stream = await acquire(...args); probe.tracks.push(...stream.getTracks()); return stream;
    };
  });
  return page;
}

test("default AI wiring demo is marked as model-free and exercises real capture/output/cleanup", { timeout: 20000 }, async (t) => {
  const page = await pageFor(t);
  assert.equal(await page.getByText("실제 AI 모델 미연결", { exact: true }).count(), 1);
  await page.getByRole("button", { name: "연결 테스트 시작", exact: true }).click();
  await page.waitForFunction(() => document.getElementById("status").textContent === "연결됨" && Number(document.getElementById("frames").textContent) > 0);
  await page.getByRole("button", { name: "테스트 응답 재생", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll("#transcripts li").length === 1 && document.getElementById("activity").textContent === "듣는 중");
  assert.ok(await page.evaluate(() => probe.buffers > 0));
  assert.match(await page.locator("#transcripts").textContent(), /실제 AI 응답이나 음성 인식 결과가 아닙니다/);
  await page.getByRole("button", { name: "마이크 음소거", exact: true }).click();
  assert.equal(await page.evaluate(() => probe.tracks.every((track) => !track.enabled)), true);
  await page.getByRole("button", { name: "종료", exact: true }).click();
  await page.waitForFunction(() => document.getElementById("status").textContent === "대기 중" && probe.contexts.every((context) => context.state === "closed"));
  assert.equal(await page.evaluate(() => probe.tracks.every((track) => track.readyState === "ended")), true);
});

test("AI interruption stops native scheduled buffers and fences stale provider audio", { timeout: 20000 }, async (t) => {
  const page = await pageFor(t);
  await page.evaluate(async () => {
    const [{ createAgentHuddle }, { openWebAudio }] = await Promise.all([
      import("/dist/agent-voice/index.js"), import("/dist/web-audio/index.js"),
    ]);
    window.ai = createAgentHuddle({ openAudio: openWebAudio, provider: {
      id: "controlled-fixture", name: "Controlled test provider",
      async open(context) {
        window.seat = context;
        return { input() { probe.captured++; }, interrupt(id) { probe.interrupts.push(id); }, close() { probe.closed++; } };
      },
    } });
    await ai.start();
  });
  await page.waitForFunction(() => probe.captured >= 3);
  // Freeze the native audio clock so scheduled output cannot finish before
  // interruption assertions, regardless of test-runner speed.
  await page.evaluate(async () => {
    await probe.contexts[0].suspend();
    seat.emit({ type: "response-started", responseId: "r1" });
    for (let i = 0; i < 3; i++) seat.emit({ type: "audio", responseId: "r1", samples: new Array(960).fill(0.1) });
    await ai.interrupt();
  });
  assert.deepEqual(await page.evaluate(() => ({ buffers: probe.buffers, stopped: probe.stopped, ids: probe.interrupts })),
    { buffers: 3, stopped: 3, ids: ["r1"] });
  await page.evaluate(() => {
    seat.emit({ type: "audio", responseId: "r1", samples: new Array(960).fill(0.1) });
    seat.emit({ type: "response-started", responseId: "r2" });
    seat.emit({ type: "audio", responseId: "r2", samples: new Array(960).fill(0.1) });
  });
  assert.equal(await page.evaluate(() => probe.buffers), 4);
  await page.evaluate(() => ai.leave());
  await page.waitForFunction(() => probe.contexts.every((context) => context.state === "closed"));
  assert.equal(await page.evaluate(() => probe.closed), 1);
  assert.equal(await page.evaluate(() => probe.tracks.every((track) => track.readyState === "ended")), true);
});
