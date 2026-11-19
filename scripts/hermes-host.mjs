import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalVoiceHost } from "./local-voice-host.mjs";
import { createHermesBackend } from "./hermes-backend.mjs";
const root=fileURLToPath(new URL("../",import.meta.url));
export function createHermesHost({port=0,cwd=process.cwd(),backend,runtimeRoot=resolve(root,".huddle-runtime/claude"),
  settings,python,model="base",language="ko",voice="Yuna",allowedOrigins=[]}={}) {
  backend??=createHermesBackend({cwd,runtimeRoot,settings,python,model,language,voice});
  return createLocalVoiceHost({id:"hermes",name:"Hermes",port,cwd,backend,allowedOrigins});
}
