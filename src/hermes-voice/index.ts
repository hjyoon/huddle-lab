import { createLocalVoiceProvider, type LocalVoiceOptions } from "../local-voice/index.js";
export function createHermesVoiceProvider(options: LocalVoiceOptions) {
  return createLocalVoiceProvider({...options,id:"local-hermes",name:"Hermes"});
}
