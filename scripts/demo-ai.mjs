import { resolve } from "node:path";
import { createAiHost } from "./ai-host.mjs";
const host=await createAiHost({port:Number(process.env.PORT??4184),cwd:resolve(process.env.HUDDLE_WORKSPACE??process.cwd()),
 codex:{binary:process.env.HUDDLE_CODEX_BINARY??"codex"},
 claude:{binary:process.env.HUDDLE_CLAUDE_BINARY??"claude",...(process.env.HUDDLE_CLAUDE_PYTHON?{python:process.env.HUDDLE_CLAUDE_PYTHON}:{}),
 model:process.env.HUDDLE_CLAUDE_ASR_MODEL??"base",language:process.env.HUDDLE_CLAUDE_LANGUAGE??"ko",voice:process.env.HUDDLE_CLAUDE_VOICE??"Yuna"},
});
console.log(`AI Huddle (choose Codex or Claude): ${host.url}/`);
for(const signal of ["SIGINT","SIGTERM"])process.once(signal,()=>{void host.close().then(()=>process.exit(0));});
