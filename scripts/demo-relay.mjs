// Development-only local relay, sharing the signed protocol fixture with tests.
import { localRelay } from "../tests/fixtures/relay.mjs";

const relay = await localRelay({ demo: true, port: Number(process.env.HUDDLE_RELAY_PORT ?? 4180) });
console.log("Huddle local Relay demo (temporary users; no external community):");
console.log(`User A: ${relay.url}/examples/browser/relay.html?peer=0`);
console.log(`User B: ${relay.url}/examples/browser/relay.html?peer=1`);
let stopping = false;
async function stop() { if (!stopping) { stopping = true; await relay.close(); } }
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
