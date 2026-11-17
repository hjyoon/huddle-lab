import { createHuddles } from "../../dist/index.js";
import { openWebAudio } from "../../dist/web-audio/index.js";

const element = (id) => document.getElementById(id);
const controls = Object.fromEntries(["start", "mute", "tone", "stop", "loopback", "status", "level", "frames", "error"].map((id) => [id, element(id)]));
const room = "00000000-0000-4000-8000-000000000002";
let receive;
let frames = 0;
const huddle = createHuddles({
  openAudio: openWebAudio,
  authorize: async () => {}, // Local-only test host, no remote identities.
  discover: async () => [],
  bridge: {
    available: true,
    async open(_id, _destination, _room, update) {
      receive = update;
      update({ type: "connected", room, participants: ["local-playback"] });
    },
    async send(_id, samples) {
      controls.frames.textContent = String(++frames);
      controls.level.value = Math.min(1, Math.sqrt(samples.reduce((sum, n) => sum + n * n, 0) / samples.length) * 5);
      if (controls.loopback.checked) receive?.({ type: "audio", peer: "local-playback", samples });
    },
    async touch() {},
    async close() { receive = undefined; },
  },
});

huddle.subscribe(() => {
  const state = huddle.snapshot();
  const connected = state.phase === "connected";
  controls.start.disabled = !["idle", "error"].includes(state.phase);
  controls.stop.disabled = !["connecting", "connected"].includes(state.phase);
  controls.mute.disabled = controls.tone.disabled = !connected;
  controls.mute.textContent = state.muted ? "음소거 해제" : "음소거";
  controls.mute.setAttribute("aria-pressed", String(state.muted));
  controls.status.textContent = ({ idle: "대기 중", connecting: "마이크 연결 중", connected: "연결됨", leaving: "종료 중", error: "연결 실패" })[state.phase];
  controls.error.textContent = state.error ?? "";
  if (!connected || state.muted) controls.level.value = 0;
});

controls.start.addEventListener("click", () => {
  frames = 0;
  controls.frames.textContent = "0";
  void huddle.start({
    scope: "local-audio-demo", viewer: "a".repeat(64), relayUrl: "https://relay.example.org",
    channelId: "00000000-0000-4000-8000-000000000001", channelName: "Local audio test",
  });
});
controls.mute.addEventListener("click", () => huddle.mute());
controls.stop.addEventListener("click", () => { void huddle.leave(); });
controls.tone.addEventListener("click", () => {
  const samples = Array.from({ length: 4800 }, (_, index) =>
    Math.sin(2 * Math.PI * 440 * index / 48000) * 0.1 * Math.sin(Math.PI * index / 4800));
  receive?.({ type: "audio", peer: "local-playback", samples });
});
window.addEventListener("pagehide", () => { void huddle.dispose(); });
