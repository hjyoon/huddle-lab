import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runOwned } from "./claude-process.mjs";
const whisperScript=fileURLToPath(new URL("./claude-whisper.py",import.meta.url));

function defaultVoice(language) {
  if (process.platform !== "linux") return "Yuna";
  return language === "auto" ? "ko" : language;
}

export async function inspectLocalTts({cwd=process.cwd(),language="ko",voice=defaultVoice(language),run=runOwned}={}) {
  const options = {cwd,timeoutMs:5000};
  if (process.platform === "linux") {
    try { await run("espeak-ng",["-q","-v",voice,"-b","1","--stdin"],{...options,input:"Huddle"}); }
    catch (error) {
      if (error.code === "ENOENT") throw new Error("Install espeak-ng for Linux speech synthesis.",{cause:error});
      throw new Error(`eSpeak NG could not load voice ${voice}. Use espeak-ng --voices to check the installed voices.`,{cause:error});
    }
    try { await run("ffmpeg",["-version"],options); }
    catch (error) { throw new Error("Install ffmpeg for Linux speech synthesis.",{cause:error}); }
    return {tts:"eSpeak NG",voice};
  }
  if (process.platform !== "darwin") throw new Error("Local speech synthesis is supported on macOS and Linux.");
  const voices=await run("say",["-v","?"],options);
  if(!voices.split("\n").some(line=>line.startsWith(voice+" ")))throw new Error(`Install the macOS voice ${voice} or configure the voice host.`);
  return {tts:"macOS say",voice};
}

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

export function createLocalSpeechBackend({cwd=process.cwd(),runtimeRoot=resolve(cwd,".huddle-runtime/claude"),
  python=join(runtimeRoot,"venv/bin/python"),model="base",language="ko",voice=defaultVoice(language),run=runOwned}={}) {
  const cache=join(runtimeRoot,"models");
  async function temporary(work,signal){
    signal?.throwIfAborted();await mkdir(runtimeRoot,{recursive:true,mode:0o700});const dir=await mkdtemp(join(runtimeRoot,"job-"));
    try{return await work(dir);}finally{await rm(dir,{recursive:true,force:true});}
  }
  return {
    async inspectSpeech() {
      try { await run(python,[whisperScript,"--cache",cache,"--model",model,"--check"],{cwd,timeoutMs:15000}); }
      catch { throw new Error("Local Whisper is not ready. Run npm run setup:voice."); }
      const tts=await inspectLocalTts({cwd,voice,run});
      return {speechReady:true,stt:"local Whisper",language,...tts};
    },
    async transcribe(samples,signal){
      return temporary(async(dir)=>{
        const path=join(dir,"input.wav");await writeFile(path,encodeWav(samples),{mode:0o600});
        const output=await run(python,[whisperScript,"--cache",cache,"--model",model,"--check","--audio",path,"--language",language],{cwd,signal,timeoutMs:45000});
        const result=JSON.parse(output.trim());return String(result.text??"").trim().slice(0,4000);
      },signal);
    },
    async synthesize(text,signal){
      return temporary(async(dir)=>{
        const input=join(dir,"text.txt"),wav=join(dir,"speech.wav");
        await writeFile(input,text,{mode:0o600});
        if (process.platform === "linux") {
          const native=join(dir,"native.wav");
          await run("espeak-ng",["-v",voice,"-b","1","-f",input,"-w",native],{cwd,signal,timeoutMs:45000});
          await run("ffmpeg",["-nostdin","-loglevel","error","-i",native,"-ac","1","-ar","48000","-c:a","pcm_s16le",wav],
            {cwd,signal,timeoutMs:10000});
        } else {
          if (process.platform !== "darwin") throw new Error("Local speech synthesis is supported on macOS and Linux.");
          const aiff=join(dir,"speech.aiff");
          await run("say",["-v",voice,"-r","190","-f",input,"-o",aiff],{cwd,signal,timeoutMs:45000});
          await run("afconvert",[aiff,wav,"-f","WAVE","-d","LEI16@48000","-c","1"],{cwd,signal,timeoutMs:10000});
        }
        return decodeWav(await readFile(wav));
      },signal);
    },
  };
}
