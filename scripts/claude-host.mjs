import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalVoiceHost } from "./local-voice-host.mjs";
import { createLocalClaudeBackend } from "./claude-backend.mjs";
const root=fileURLToPath(new URL("../",import.meta.url));
export function createClaudeHost({port=4183,cwd=process.cwd(),backend,
  runtimeRoot=resolve(root,".huddle-runtime/claude"),binary="claude",python,model="base",language="ko",voice="Yuna",allowedOrigins=[]}={}) {
  backend??=createLocalClaudeBackend({cwd,runtimeRoot,binary,...(python?{python}:{}),model,language,voice});
  return createLocalVoiceHost({id:"claude",name:"Claude",entry:"claude.html",port,cwd,backend,allowedOrigins});
}
