import { copyFile } from "node:fs/promises";

await copyFile(
  new URL("../src/web-audio/capture.worklet.js", import.meta.url),
  new URL("../dist/web-audio/capture.worklet.js", import.meta.url),
);
