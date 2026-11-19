import { mkdir, access } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runOwned } from "./claude-process.mjs";
import { inspectLocalTts } from "./local-speech.mjs";
const root=fileURLToPath(new URL("../",import.meta.url)),runtime=resolve(root,".huddle-runtime/claude");
const python=join(runtime,"venv/bin/python");
const tts=await inspectLocalTts({language:process.env.HUDDLE_CLAUDE_LANGUAGE,voice:process.env.HUDDLE_CLAUDE_VOICE});
console.log(`Local speech synthesis ready (${tts.tts}, ${tts.voice}).`);
await mkdir(runtime,{recursive:true,mode:0o700});
try{await access(python);}catch{
  const source=process.env.HUDDLE_PYTHON??"python3";
  const version=(await runOwned(source,["--version"],{timeoutMs:5000})).trim();
  const minor=Number(version.match(/Python 3\.(\d+)/)?.[1]);
  if(!Number.isInteger(minor)||minor<10||minor>13)throw new Error("Set HUDDLE_PYTHON to Python 3.10–3.13 (3.12 recommended).");
  await runOwned(source,["-m","venv",join(runtime,"venv")],{timeoutMs:30000});
}
console.log("Installing local Whisper dependencies…");
await runOwned(python,["-m","pip","install","--disable-pip-version-check","--cache-dir",join(runtime,"pip-cache"),"faster-whisper==1.2.1","av==16.1.0"],{timeoutMs:180000});
console.log("Downloading/caching multilingual Whisper base weights…");
await runOwned(python,[fileURLToPath(new URL("./claude-whisper.py",import.meta.url)),"--cache",join(runtime,"models"),"--model",process.env.HUDDLE_CLAUDE_ASR_MODEL??"base"],{timeoutMs:300000});
console.log("Local speech setup complete. Run npm run demo.");
