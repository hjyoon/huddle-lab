import { createAgentHuddle } from "../../dist/agent-voice/index.js";
import { openWebAudio } from "../../dist/web-audio/index.js";
import { createCodexVoiceProvider, createCodexLocalConnector } from "../../dist/codex-voice/index.js";
const element = (id) => document.getElementById(id);
let ready = false;
const provider = createCodexVoiceProvider({ connect: createCodexLocalConnector(`ws://${location.host}/codex`) });
const huddle = createAgentHuddle({ provider, openAudio: openWebAudio });
const render = () => {
  const state = huddle.snapshot(), connected = state.phase === "connected";
  element("start").disabled = !ready || !["idle", "error"].includes(state.phase);
  element("mute").disabled = !connected;
  element("interrupt").disabled = !connected || !["thinking", "speaking"].includes(state.activity);
  element("stop").disabled = !["connecting", "connected"].includes(state.phase);
  element("mute").textContent = state.muted ? "마이크 음소거 해제" : "마이크 음소거";
  element("mute").setAttribute("aria-pressed", String(state.muted));
  element("status").textContent = ({ idle:"대기 중",connecting:"Codex 연결 중",connected:"통화 중",leaving:"종료 중",error:"연결 실패" })[state.phase];
  element("activity").textContent = ({ idle:"대기",listening:"듣는 중",thinking:"생각 중",speaking:"말하는 중" })[state.activity];
  element("error").textContent = state.error ?? "";
  element("transcripts").replaceChildren(...state.transcripts.map((row) => {
    const item = document.createElement("li"); item.textContent = `${row.speaker === "user" ? "사용자" : "Codex"}: ${row.text}`; return item;
  }));
};
huddle.subscribe(render);
try {
  const status = await (await fetch("/codex/status")).json();
  ready = status.ready && !status.busy;
  element("workspace").textContent = status.workspace;
  element("setup").textContent = ready ? `${status.version} · 로그인 연결 준비됨` : (status.error ?? "codex login으로 로그인한 뒤 서버를 다시 시작해 주세요.");
} catch { element("setup").textContent = "로컬 Codex 서버를 확인해 주세요."; }
render();
element("start").onclick = () => { void huddle.start(); };
element("mute").onclick = () => huddle.mute();
element("interrupt").onclick = () => { void huddle.interrupt(); };
element("stop").onclick = () => { void huddle.leave(); };
window.addEventListener("pagehide", () => { void huddle.dispose(); });
