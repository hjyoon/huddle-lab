// Local speech engines only. Does not call Claude or acquire a microphone.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createLocalClaudeBackend,encodeWav } from "./claude-backend.mjs";
const backend=createLocalClaudeBackend();
const text="안녕하세요. 음성 연결을 준비했습니다.",signal=new AbortController().signal;
const start=performance.now(),audio=await backend.synthesize(text,signal),ttsMs=performance.now()-start;
assert.ok(audio.length>960&&audio.some(value=>Math.abs(value)>.01));
const before=performance.now(),recognized=await backend.transcribe(audio,signal),sttMs=performance.now()-before;
assert.match(recognized,/안녕하세요/);assert.match(recognized,/음성/);
const result={mode:"local speech engines; no Claude inference; synthetic audio only",engine:"faster-whisper 1.2.1 / PyAV 16.1.0",model:"base",voice:"Yuna",language:"ko",input:text,recognized,
  durationSeconds:audio.length/48000,ttsMs:Math.round(ttsMs),sttMs:Math.round(sttMs),passed:true};
const directory=resolve(".huddle-runtime/claude/verification");await mkdir(directory,{recursive:true,mode:0o700});
await writeFile(resolve(directory,"speech.wav"),encodeWav(audio),{mode:0o600});
await writeFile(resolve(directory,"speech.json"),JSON.stringify(result,null,2)+"\n",{mode:0o600});
console.log(JSON.stringify(result,null,2));
