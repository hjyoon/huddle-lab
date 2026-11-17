import { createHuddles } from "../../dist/index.js";
import { createRelayAdapter } from "../../dist/relay/index.js";
import { openWebAudio } from "../../dist/web-audio/index.js";
import { createWebCodecsCodec } from "../../dist/webcodecs/index.js";

const element = (id) => document.getElementById(id);
async function initialize() {
  const response = await fetch("/local-config");
  if (!response.ok) throw new Error("Start this example with npm run demo:relay.");
  const config = await response.json();
  const peer = new URL(location.href).searchParams.get("peer") === "1" ? 1 : 0;
  element("identity").textContent = `임시 사용자 ${peer === 0 ? "A" : "B"}`;
  const adapter = createRelayAdapter({ relayUrl: config.relayUrl, relayPubkey: config.relayPubkey, scope: config.scope,
    identity: { pubkey: config.viewers[peer], async signEvent(event) {
      const reply = await fetch("/local-sign", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ peer, event }) });
      if (!reply.ok) throw new Error("The local test signer refused the event.");
      return reply.json();
    } }, createCodec: createWebCodecsCodec,
  });
  let received = 0;
  const huddle = createHuddles({ ...adapter, openAudio: async (send, ended, signal) => {
    const audio = await openWebAudio(send, ended, signal);
    return { ...audio, play(pubkey, samples) { element("received").textContent = String(++received); audio.play(pubkey, samples); } };
  } });
  const update = () => {
    const state = huddle.snapshot(), connected = state.phase === "connected";
    element("start").disabled = !["idle", "error"].includes(state.phase);
    element("mute").disabled = !connected;
    element("stop").disabled = !["connecting", "connected"].includes(state.phase);
    element("mute").textContent = state.muted ? "음소거 해제" : "음소거";
    element("mute").setAttribute("aria-pressed", String(state.muted));
    element("status").textContent = ({ idle: "대기 중", connecting: "연결 중", connected: "연결됨", leaving: "종료 중", error: "연결 실패" })[state.phase];
    element("participants").textContent = String(state.participants.length);
    element("error").textContent = state.error ?? "";
  };
  huddle.subscribe(update);
  update();
  element("start").addEventListener("click", () => {
    received = 0; element("received").textContent = "0";
    void huddle.start({ scope: config.scope, viewer: config.viewers[peer], relayUrl: config.relayUrl,
      channelId: config.parent, channelName: "Local Relay" });
  });
  element("mute").addEventListener("click", () => huddle.mute());
  element("stop").addEventListener("click", () => { void huddle.leave(); });
  window.addEventListener("pagehide", () => { void huddle.dispose(); void adapter.dispose(); });
}
void initialize().catch((error) => { element("error").textContent = error.message; });
