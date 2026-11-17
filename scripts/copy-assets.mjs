import { copyFile } from "node:fs/promises";

await copyFile(
  new URL("../src/web-audio/capture.worklet.js", import.meta.url),
  new URL("../dist/web-audio/capture.worklet.js", import.meta.url),
);
await copyFile(
  new URL("../src/codex-voice/capture.worklet.js", import.meta.url),
  new URL("../dist/codex-voice/capture.worklet.js", import.meta.url),
);
