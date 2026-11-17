import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runOwned } from "./claude-process.mjs";
const whisperScript=fileURLToPath(new URL("./claude-whisper.py",import.meta.url));

export function encodeWav(samples) {
  const bytes=Buffer.alloc(44+samples.length*2);
  bytes.write("RIFF");bytes.writeUInt32LE(bytes.length-8,4);bytes.write("WAVEfmt ",8);bytes.writeUInt32LE(16,16);
  bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(48000,24);bytes.writeUInt32LE(96000,28);
  bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write("data",36);bytes.writeUInt32LE(samples.length*2,40);
  samples.forEach((value,i)=>bytes.writeInt16LE(Math.round(Math.max(-1,Math.min(1,value))*32767),44+i*2));
  return bytes;
}
export function decodeWav(bytes) {
  if(bytes.toString("ascii",0,4)!=="RIFF"||bytes.toString("ascii",8,12)!=="WAVE")throw new Error("TTS did not produce a WAV file.");
  let format,pcm;
  for(let offset=12;offset+8<=bytes.length;){
    const size=bytes.readUInt32LE(offset+4),start=offset+8,end=start+size;
    if(end>bytes.length)throw new Error("Truncated TTS WAV file.");
    const name=bytes.toString("ascii",offset,offset+4);
    if(name==="fmt ")format=bytes.subarray(start,end);
    if(name==="data")pcm=bytes.subarray(start,end);
    offset=end+(size%2);
  }
  if(!format||format.length<16||format.readUInt16LE(0)!==1||format.readUInt16LE(2)!==1||format.readUInt32LE(4)!==48000||format.readUInt16LE(14)!==16||!pcm||pcm.length%2)
    throw new Error("TTS requires 48 kHz mono PCM16 WAV.");
  if(pcm.length>48000*2*60)throw new Error("TTS response exceeds 60 seconds.");
  return Float32Array.from({length:pcm.length/2},(_,i)=>pcm.readInt16LE(i*2)/32768);
}

export function createLocalClaudeBackend({cwd=process.cwd(),runtimeRoot=resolve(cwd,".huddle-runtime/claude"),binary="claude",
  python=join(runtimeRoot,"venv/bin/python"),model="base",language="ko",voice="Yuna",run=runOwned}={}) {
  const cache=join(runtimeRoot,"models");
  async function temporary(work,signal){
    signal?.throwIfAborted();await mkdir(runtimeRoot,{recursive:true,mode:0o700});const dir=await mkdtemp(join(runtimeRoot,"job-"));
    try{return await work(dir);}finally{await rm(dir,{recursive:true,force:true});}
  }
  return {
    async inspect() {
      const result={workspace:cwd,engine:"Claude Code",stt:"local Whisper",tts:"macOS say",language,voice,tools:false};
      try {
        result.version=(await run(binary,["--version"],{cwd,timeoutMs:5000})).trim();
        const auth=JSON.parse(await run(binary,["auth","status"],{cwd,timeoutMs:10000}));result.signedIn=!!auth.loggedIn;
        try { await run(python,[whisperScript,"--cache",cache,"--model",model,"--check"],{cwd,timeoutMs:15000}); }
        catch { throw new Error("Local Whisper is not ready. Run npm run setup:claude."); }
        if(process.platform!=="darwin")throw new Error("The default TTS host requires macOS.");
        const voices=await run("say",["-v","?"],{cwd,timeoutMs:5000});
        if(!voices.split("\n").some(line=>line.startsWith(voice+" ")))throw new Error(`Install the macOS voice ${voice} or set HUDDLE_CLAUDE_VOICE.`);
        result.ready=result.signedIn;result.speechReady=true;
        if(!result.signedIn)result.error="Run claude auth login before starting voice.";
      }catch(error){result.ready=false;result.error=error.message;}
      return result;
    },
    async transcribe(samples,signal){
      return temporary(async(dir)=>{
        const path=join(dir,"input.wav");await writeFile(path,encodeWav(samples),{mode:0o600});
        const output=await run(python,[whisperScript,"--cache",cache,"--model",model,"--check","--audio",path,"--language",language],{cwd,signal,timeoutMs:45000});
        const result=JSON.parse(output.trim());return String(result.text??"").trim().slice(0,4000);
      },signal);
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
    async synthesize(text,signal){
      return temporary(async(dir)=>{
        const input=join(dir,"text.txt"),aiff=join(dir,"speech.aiff"),wav=join(dir,"speech.wav");
        await writeFile(input,text,{mode:0o600});
        await run("say",["-v",voice,"-r","190","-f",input,"-o",aiff],{cwd,signal,timeoutMs:45000});
        await run("afconvert",[aiff,wav,"-f","WAVE","-d","LEI16@48000","-c","1"],{cwd,signal,timeoutMs:10000});
        return decodeWav(await readFile(wav));
      },signal);
    },
  };
}
