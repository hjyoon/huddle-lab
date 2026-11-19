import assert from "node:assert/strict";
import { test } from "node:test";
import { createSpeechGate } from "../dist/claude-voice/vad.js";
import { encodeWav,decodeWav,createLocalClaudeBackend } from "../scripts/claude-backend.mjs";
import { runOwned } from "../scripts/claude-process.mjs";
const silence=new Array(960).fill(0),speech=new Array(960).fill(.1);

test("speech gate retains onset, rejects clicks, finalizes pauses and can restart after reset",()=>{
 const events=[],frames=[];const gate=createSpeechGate({start(){events.push('start');},frame(f){frames.push(f);},end(valid){events.push(valid?'commit':'discard');}});
 for(let i=0;i<10;i++)gate.input(silence);
 for(let i=0;i<2;i++)gate.input(speech);assert.deepEqual(events,[]);
 gate.input(speech);assert.deepEqual(events,['start']);assert.equal(frames.length,10);assert.equal(frames.at(-1),speech);
 for(let i=0;i<35;i++)gate.input(silence);assert.deepEqual(events,['start','discard']);
 for(let i=0;i<8;i++)gate.input(speech);gate.flush();assert.deepEqual(events,['start','discard','start','commit']);
 gate.close();for(let i=0;i<2;i++)gate.input(speech);assert.equal(events.length,4);gate.input(speech);assert.equal(events.at(-1),'start');
 gate.close();gate.flush();assert.equal(events.at(-1),'start');
});
test("speech gate caps an utterance and waits for silence before another one",()=>{
 const events=[];const gate=createSpeechGate({maxFrames:10,silenceFrames:4,start(){events.push('start');},frame(){},end(valid){events.push(valid);}});
 for(let i=0;i<50;i++)gate.input(speech);assert.deepEqual(events,['start',true]);
 for(let i=0;i<4;i++)gate.input(silence);for(let i=0;i<3;i++)gate.input(speech);assert.equal(events.at(-1),'start');
});
test("PCM WAV roundtrip preserves samples and rejects malformed audio",()=>{
 const samples=Float32Array.from([-1,-.5,0,.5,1]);const wav=encodeWav(samples),back=decodeWav(wav);
 assert.equal(back.length,samples.length);back.forEach((n,i)=>assert.ok(Math.abs(n-samples[i])<.0001));
 assert.throws(()=>decodeWav(wav.subarray(0,48)),/Truncated/);
 const invalid=Buffer.from(wav);invalid.writeUInt32LE(24000,24);assert.throws(()=>decodeWav(invalid),/48 kHz/);
});
test("Claude CLI parser uses completed result, passes history on stdin and disables tools",async()=>{
 let captured;
 const backend=createLocalClaudeBackend({run:async(binary,args,options)=>{
  captured={binary,args,options};options.onLine(JSON.stringify({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'partial'}}}));
  options.onLine(JSON.stringify({type:'result',is_error:false,result:'안녕하세요.'}));return '';
 }});
 assert.equal(await backend.reply([{role:'user',content:'hello'}],new AbortController().signal),'안녕하세요.');
 assert.equal(captured.args[captured.args.indexOf('--tools')+1],'');
 assert.equal(captured.args[captured.args.indexOf('--mcp-config')+1],'{"mcpServers":{}}');
 assert.match(captured.args[captured.args.indexOf('--system-prompt')+1],/distinguish general support from the current connection status/);
 assert.match(captured.options.input,/hello/);assert.equal(captured.args.includes('hello'),false);
});
test("Claude completes standalone promises before speech synthesis without another CLI request",async()=>{
 let calls=0;
 const backend=createLocalClaudeBackend({run:async(_,__,options)=>{
  calls++;
  options.onLine(JSON.stringify({type:'result',is_error:false,result:'네, 알아볼게요.'}));
 }});
 const reply=await backend.reply([{role:'user',content:'슬랙 연결 가능해?'}],new AbortController().signal);
 assert.match(reply,/이 통화에서 외부 서비스의 상태를 직접 확인할 수는 없어요/);
 assert.equal(calls,1);
});
test("Claude authentication failure is not reported as a spoken model answer",async()=>{
 const backend=createLocalClaudeBackend({run:async(_,__,options)=>{
  options.onLine(JSON.stringify({type:'result',is_error:true,result:'Not logged in · Please run /login'}));
 }});
 await assert.rejects(backend.reply([],new AbortController().signal),/Not logged in/);
});
test("owned CLI cancellation waits for process exit and releases the request",async()=>{
 const abort=new AbortController();let ready;const started=new Promise(r=>{ready=r;});let cleaned=false;
 const work=runOwned(process.execPath,['-e',`process.on('SIGTERM',()=>setTimeout(()=>{console.log('cleaned');process.exit(0)},40));console.log('ready');setInterval(()=>{},1000)`],{
  signal:abort.signal,onLine(line){if(line==='ready')ready();if(line==='cleaned')cleaned=true;},timeoutMs:5000,
 });
 await started;abort.abort(new Error('cancel-test'));await assert.rejects(work,/cancel-test/);assert.equal(cleaned,true);
});
