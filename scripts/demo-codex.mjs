import { resolve } from "node:path";
import { createCodexHost } from "./codex-host.mjs";
const host = await createCodexHost({
  cwd: resolve(process.env.HUDDLE_WORKSPACE ?? process.cwd()),
  binary: process.env.HUDDLE_CODEX_BINARY ?? "codex",
  model: process.env.HUDDLE_CODEX_MODEL || undefined,
  port: Number(process.env.PORT ?? 4182),
});
console.log(`Codex AI Huddle: ${host.url}/`);
console.log("Uses the installed Codex login; the new conversation uses a read-only workspace.");
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { void host.close().then(() => process.exit(0)); });
