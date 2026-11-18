import { createLocalVoiceProvider, type LocalVoiceOptions } from "../local-voice/index.js";
export function createClaudeVoiceProvider(options: LocalVoiceOptions) {
  return createLocalVoiceProvider({...options,id:"local-claude",name:"Claude"});
}
