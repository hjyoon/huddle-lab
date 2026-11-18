import { createLocalVoiceProvider, type LocalVoiceOptions } from "../local-voice/index.js";
export function createOpenClawVoiceProvider(options: LocalVoiceOptions) {
  return createLocalVoiceProvider({...options,id:"local-openclaw",name:"OpenClaw"});
}
