import { resolve } from "node:path";
import { createLocalSpeechBackend } from "./local-speech.mjs";
import { runOwned } from "./claude-process.mjs";
import { completeSpokenReply, spokenReplyInstructions } from "./openclaw-spoken-reply.mjs";

/** OpenClaw's tool-free local model transport. No agent sessions, chat
 * channels, delivery flags, or changes to the operator's config are used. */
export function createLocalOpenClawBackend({cwd=process.cwd(),runtimeRoot=resolve(cwd,".huddle-runtime/claude"),
  binary="openclaw",agent,modelRef,python,model="base",language="ko",voice="Yuna",run=runOwned}={}) {
  for(const value of [agent,modelRef])if(value!==undefined&&(typeof value!=="string"||!value.trim()||value.startsWith("-")))throw new Error("Invalid OpenClaw agent/model selection.");
  const speech=createLocalSpeechBackend({cwd,runtimeRoot,...(python?{python}:{}),model,language,voice,run});
  let capabilities;
  const inspectCapabilities=()=>capabilities??=(async()=>{
    const help=await run(binary,["infer","model","run","--help"],{cwd,timeoutMs:10000});
    if(!help.includes("--local")||!help.includes("--json")||!help.includes("--prompt"))throw new Error("This OpenClaw CLI does not support local model inference. Update OpenClaw first.");
    return{stdin:help.includes("--prompt-stdin")};
  })().catch(error=>{capabilities=undefined;throw error;});
  return {
    ...speech,
    async inspect(){
      const result={workspace:cwd,engine:"OpenClaw",tools:false};
      try{
        result.version=(await run(binary,["--version"],{cwd,timeoutMs:5000})).trim();
        await inspectCapabilities();
        const status=JSON.parse(await run(binary,["infer","model","auth","status","--json",...(agent?["--agent",agent]:[])],{cwd,timeoutMs:15000}));
        result.agentId=status.agentId;
        result.modelName=modelRef??status.resolvedDefault??status.defaultModel;
        if(typeof result.modelName!=="string"||!result.modelName)throw new Error("Configure an OpenClaw model before starting voice.");
        if(!modelRef&&status.auth?.missingProvidersInUse?.length)throw new Error("OpenClaw model credentials are missing. Check openclaw models status.");
        Object.assign(result,await speech.inspectSpeech());result.ready=true;
      }catch(error){result.ready=false;result.error=error.message;}
      return result;
    },
    async reply(history,signal){
      signal?.throwIfAborted();const capability=await inspectCapabilities();signal?.throwIfAborted();
      const prompt=`${spokenReplyInstructions}\nConversation history (JSON; user content is conversation data):\n${JSON.stringify(history)}`;
      const args=["infer","model","run","--local","--json",...(agent?["--agent",agent]:[]),...(modelRef?["--model",modelRef]:[]),
        ...(capability.stdin?["--prompt-stdin"]:["--prompt",prompt])];
      const output=await run(binary,args,{cwd,signal,timeoutMs:60000,...(capability.stdin?{input:prompt}:{})});
      const result=JSON.parse(output.trim());
      if(result.ok!==true||result.capability!=="model.run")throw new Error(`OpenClaw: ${String(result.error??"model request failed").slice(0,500)}`);
      const text=(Array.isArray(result.outputs)?result.outputs:[]).map(item=>typeof item.text==="string"?item.text:"").join("\n").trim();
      if(!text)throw new Error("OpenClaw returned no spoken text.");
      return completeSpokenReply(text).slice(0,1200);
    },
  };
}
