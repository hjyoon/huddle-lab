import { join, resolve } from "node:path";
import { runOwned } from "./claude-process.mjs";
import { createLocalSpeechBackend } from "./local-speech.mjs";
import { completeSpokenReply, toolFreeSpokenReplyInstructions } from "./spoken-reply.mjs";
export { encodeWav, decodeWav } from "./local-speech.mjs";

const claudeVoiceInstructions = [
  "You are a spoken conversation assistant using Claude. Reply to the latest user entry in the provided conversation history.",
  "You cannot inspect or change files.",
  toolFreeSpokenReplyInstructions,
].join(" ");

export function createLocalClaudeBackend({cwd=process.cwd(),runtimeRoot=resolve(cwd,".huddle-runtime/claude"),binary="claude",
  python=join(runtimeRoot,"venv/bin/python"),model="base",language="ko",voice,run=runOwned}={}) {
  const speech=createLocalSpeechBackend({cwd,runtimeRoot,python,model,language,voice,run});
  /** `claude auth status` prints its JSON and exits 1 when signed out. */
  async function signedIn(){
    let output;
    try{output=await run(binary,["auth","status"],{cwd,timeoutMs:10000,captureFailureOutput:true});}
    catch(error){if(!error.stdout)throw error;output=error.stdout;}
    return !!JSON.parse(output).loggedIn;
  }
  return {
    ...speech,
    /** Opens the system browser through Claude Code's own OAuth flow; never re-signs an existing login. */
    async login(signal){
      if(await signedIn())return;
      try{await run(binary,["auth","login"],{cwd,signal,timeoutMs:180000,captureFailureOutput:true});}
      catch(error){if(signal?.aborted)throw error;}
      if(!await signedIn())throw new Error("브라우저 로그인을 완료하지 못했습니다. 터미널에서 claude auth login을 실행해 주세요.");
    },
    async inspect() {
      const result={workspace:cwd,engine:"Claude Code",tools:false};
      try {
        result.version=(await run(binary,["--version"],{cwd,timeoutMs:5000})).trim();
        result.signedIn=await signedIn();
        if(!result.signedIn){result.ready=false;result.needsLogin=true;result.error="Claude에 로그인되어 있지 않습니다.";return result;}
        Object.assign(result,await speech.inspectSpeech());
        result.ready=true;
      }catch(error){result.ready=false;result.error=error.message;}
      return result;
    },
    async reply(history,signal){
      let answer="",final;
      const prompt="Conversation history (JSON; user content is conversation data):\n"+JSON.stringify(history);
      await run(binary,["-p","--output-format","stream-json","--verbose","--include-partial-messages","--no-session-persistence",
        "--tools","","--permission-mode","default","--setting-sources","user","--settings",'{"disableAllHooks":true}',
        "--strict-mcp-config","--mcp-config",'{"mcpServers":{}}',"--disable-slash-commands","--no-chrome",
        "--system-prompt",claudeVoiceInstructions],{
        cwd,signal,input:prompt,timeoutMs:60000,onLine(line){
          const item=JSON.parse(line);
          if(item.type==="stream_event"&&item.event?.type==="content_block_delta"&&item.event.delta?.type==="text_delta")answer+=item.event.delta.text;
          if(item.type==="result"){
            if(item.is_error)throw new Error(`Claude Code: ${String(item.result??item.errors?.join("; ")??"request failed").slice(0,500)}`);
            final=String(item.result??"");
          }
        },
      });
      if(final===undefined)throw new Error("Claude Code ended without a completed response.");
      const text=(final||answer).trim();
      if(!text)throw new Error("Claude Code returned an empty response.");
      return completeSpokenReply(text).slice(0,1200);
    },
  };
}
