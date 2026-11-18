import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalVoiceHost } from "./local-voice-host.mjs";
import { createLocalOpenClawBackend } from "./openclaw-backend.mjs";
const root=fileURLToPath(new URL("../",import.meta.url));
export function createOpenClawHost({port=0,cwd=process.cwd(),backend,runtimeRoot=resolve(root,".huddle-runtime/claude"),
  binary="openclaw",agent,modelRef,python,model="base",language="ko",voice="Yuna",allowedOrigins=[]}={}) {
  backend??=createLocalOpenClawBackend({cwd,runtimeRoot,binary,agent,modelRef,python,model,language,voice});
  return createLocalVoiceHost({id:"openclaw",name:"OpenClaw",port,cwd,backend,allowedOrigins});
}
