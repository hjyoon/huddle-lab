import { resolve } from "node:path";
import { createClaudeHost } from "./claude-host.mjs";
const host=await createClaudeHost({port:Number(process.env.PORT??4183),cwd:resolve(process.env.HUDDLE_WORKSPACE??process.cwd()),
  binary:process.env.HUDDLE_CLAUDE_BINARY??"claude",...(process.env.HUDDLE_CLAUDE_PYTHON?{python:process.env.HUDDLE_CLAUDE_PYTHON}:{}),
  model:process.env.HUDDLE_CLAUDE_ASR_MODEL??"base",language:process.env.HUDDLE_CLAUDE_LANGUAGE??"ko",voice:process.env.HUDDLE_CLAUDE_VOICE??"Yuna"});
console.log(`Claude AI Huddle: ${host.url}/`);
console.log("Local Whisper + Claude Code login + macOS voice synthesis.");
for(const signal of ["SIGINT","SIGTERM"])process.once(signal,()=>{void host.close().then(()=>process.exit(0));});
