import { createAgentHuddle } from "../../dist/agent-voice/index.js";
import { openWebAudio } from "../../dist/web-audio/index.js";
import { createTestProvider } from "./agent-fixture.js";

const element = (id) => document.getElementById(id);
let frames = 0;
const fixture = createTestProvider((samples) => {
  element("frames").textContent = String(++frames);
  element("level").value = Math.min(1, Math.sqrt(samples.reduce((sum, n) => sum + n * n, 0) / samples.length) * 5);
});
const huddle = createAgentHuddle({ provider: fixture.provider, openAudio: openWebAudio });
huddle.subscribe(() => {
  const state = huddle.snapshot(), connected = state.phase === "connected";
  element("start").disabled = !["idle", "error"].includes(state.phase);
  element("mute").disabled = element("respond").disabled = !connected;
  element("interrupt").disabled = !connected || !["thinking", "speaking"].includes(state.activity);
  element("stop").disabled = !["connecting", "connected"].includes(state.phase);
  element("mute").textContent = state.muted ? "마이크 음소거 해제" : "마이크 음소거";
  element("mute").setAttribute("aria-pressed", String(state.muted));
  element("status").textContent = ({ idle: "대기 중", connecting: "제공자 연결 중", connected: "연결됨", leaving: "종료 중", error: "연결 실패" })[state.phase];
  element("activity").textContent = ({ idle: "대기", listening: "듣는 중", thinking: "생각 중", speaking: "말하는 중" })[state.activity];
  element("error").textContent = state.error ?? "";
  if (!connected || state.muted) element("level").value = 0;
  element("transcripts").replaceChildren(...state.transcripts.map((row) => {
    const item = document.createElement("li");
    item.textContent = `${row.speaker === "user" ? "사용자" : "테스트 제공자"}: ${row.text}`;
    return item;
  }));
});
element("start").addEventListener("click", () => {
  frames = 0; element("frames").textContent = "0";
  void huddle.start();
});
element("mute").addEventListener("click", () => huddle.mute());
element("respond").addEventListener("click", () => fixture.respond());
element("interrupt").addEventListener("click", () => { void huddle.interrupt(); });
element("stop").addEventListener("click", () => { void huddle.leave(); });
window.addEventListener("pagehide", () => { void huddle.dispose(); });
