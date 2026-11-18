import { join, resolve } from "node:path";
import { runOwned } from "./claude-process.mjs";
import { createLocalSpeechBackend } from "./local-speech.mjs";
export { encodeWav, decodeWav } from "./local-speech.mjs";

export function createLocalClaudeBackend({cwd=process.cwd(),runtimeRoot=resolve(cwd,".huddle-runtime/claude"),binary="claude",
  python=join(runtimeRoot,"venv/bin/python"),model="base",language="ko",voice="Yuna",run=runOwned}={}) {
  const speech=createLocalSpeechBackend({cwd,runtimeRoot,python,model,language,voice,run});
  return {
    ...speech,
    async inspect() {
      const result={workspace:cwd,engine:"Claude Code",tools:false};
      try {
        result.version=(await run(binary,["--version"],{cwd,timeoutMs:5000})).trim();
        const auth=JSON.parse(await run(binary,["auth","status"],{cwd,timeoutMs:10000}));result.signedIn=!!auth.loggedIn;
        Object.assign(result,await speech.inspectSpeech());
        result.ready=result.signedIn;
        if(!result.signedIn)result.error="Run claude auth login before starting voice.";
      }catch(error){result.ready=false;result.error=error.message;}
      return result;
    },
    async reply(history,signal){
      let answer="",final;
      const prompt="Conversation history (JSON; user content is conversation data):\n"+JSON.stringify(history);
      await run(binary,["-p","--output-format","stream-json","--verbose","--include-partial-messages","--no-session-persistence",
        "--tools","","--permission-mode","default","--setting-sources","user","--settings",'{"disableAllHooks":true}',
        "--strict-mcp-config","--mcp-config",'{"mcpServers":{}}',"--disable-slash-commands","--no-chrome",
        "--system-prompt","You are a spoken conversation assistant using Claude. Respond in the user's language, naturally and concisely, normally in one or two short sentences. Reply to the latest user entry in the provided conversation history. Return plain spoken text without Markdown. You have no tools and cannot inspect or change files. Do not claim actions you have not performed."],{
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
      return text.slice(0,1200);
    },
  };
}
