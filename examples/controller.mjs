// In-memory host adapters demonstrate the core API. No microphone or network.
import { createHuddles } from "huddle-lab";

const room = "00000000-0000-4000-8000-000000000002";
let captured;
const huddle = createHuddles({
  createId: () => "demo-call",
  authorize: async () => {
    // A real host checks the signed-in identity, current session and membership.
  },
  discover: async () => [],
  bridge: {
    available: true,
    async open(_id, destination, selected, receive) {
      receive({ type: "connected", room: selected ?? room, participants: [destination.viewer] });
    },
    async send(_id, samples) { console.log(`PCM frame: ${samples.length} samples`); },
    async touch() {},
    async close(id) { console.log(`Closed: ${id}`); },
  },
  async openAudio(send) {
    captured = send;
    return { mute() {}, play() {}, participants() {}, close() {} };
  },
});

huddle.subscribe(() => {
  const { phase, muted } = huddle.snapshot();
  console.log(`State: ${phase}, muted: ${muted}`);
});

try {
  await huddle.start({
    scope: "demo", viewer: "a".repeat(64), relayUrl: "https://relay.example.org",
    channelId: "00000000-0000-4000-8000-000000000001", channelName: "Demo",
  });
  captured(new Array(960).fill(0));
  huddle.mute();
  captured(new Array(960).fill(0)); // Suppressed while muted.
  await huddle.leave();
} finally {
  await huddle.dispose();
}
