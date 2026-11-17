import assert from "node:assert/strict";
import { test } from "node:test";
import { WebSocket } from "ws";
import { createClaudeHost } from "../scripts/claude-host.mjs";
const frame=()=>{const b=Buffer.alloc(3840);for(let i=0;i<960;i++)b.writeFloatLE(.1,i*4);return b;};
function fixture(overrides={}){
 const calls=[];return{calls,async inspect(){return{ready:true,version:'fixture',workspace:process.cwd()};},async transcribe(samples){calls.push('stt');assert.equal(samples.length,5*960);return'hello';},async reply(history){calls.push('reply');assert.equal(history.at(-1).content,'hello');return'answer';},async synthesize(){calls.push('tts');return new Float32Array(960*3).fill(.1);},...overrides};
}
async function connect(host){
 const socket=new WebSocket(host.url.replace('http:','ws:')+'/claude',{origin:host.url}),events=[];
 socket.on('message',(raw,binary)=>events.push(binary?{type:'audio',seq:raw.readUInt32LE(0),length:raw.length}:JSON.parse(raw)));
 await new Promise((r,j)=>{socket.once('open',r);socket.once('error',j);});
 const wait=async(predicate)=>{const deadline=Date.now()+4000;while(!predicate(events)){if(Date.now()>deadline)throw new Error('Event timeout: '+JSON.stringify(events));await new Promise(r=>setTimeout(r,5));}};
 const send=(value)=>socket.send(JSON.stringify(value));send({type:'voice/open'});await wait(es=>es.some(e=>e.type==='voice/ready'));
 return{socket,events,send,wait,utter(seq){send({type:'input/start',seq});for(let i=0;i<5;i++)socket.send(frame());send({type:'input/commit',seq});}};
}
test("Claude host processes PCM through STT/model/TTS and paces tagged output",async t=>{
 const backend=fixture(),host=await createClaudeHost({port:0,backend});t.after(()=>host.close());const c=await connect(host);t.after(()=>c.socket.terminate());
 c.utter(1);await c.wait(es=>es.some(e=>e.type==='response-ended'));
 assert.deepEqual(backend.calls,['stt','reply','tts']);assert.equal(c.events.filter(e=>e.type==='audio').length,3);
 assert.ok(c.events.filter(e=>e.type==='audio').every(e=>e.seq===1&&e.length===3844));
 assert.deepEqual(c.events.filter(e=>e.type==='transcript').map(e=>e.text),['hello','answer']);
 c.send({type:'voice/close'});await c.wait(es=>es.some(e=>e.type==='voice/closed'));
});
test("new speech cancels a pending worker and fences late old text/audio",async t=>{
 let release,started,firstSignal,calls=0;const first=new Promise(r=>{started=r;});
 const backend=fixture({async transcribe(_,signal){calls++;if(calls===1){firstSignal=signal;started();return new Promise(r=>{release=()=>{assert.equal(signal.aborted,true);r('stale');};});}return'hello';}});
 const host=await createClaudeHost({port:0,backend});t.after(()=>host.close());const c=await connect(host);t.after(()=>c.socket.terminate());
 c.utter(1);await first;c.utter(2);await c.wait(()=>firstSignal.aborted);release();await c.wait(es=>es.some(e=>e.type==='response-ended'&&e.seq===2));
 assert.equal(c.events.some(e=>e.type==='transcript'&&e.text==='stale'),false);
 assert.ok(c.events.filter(e=>e.type==='audio').every(e=>e.seq===2));assert.equal(calls,2);
});
test("Claude host rejects foreign origins, concurrent clients and non-finite PCM",async t=>{
 const host=await createClaudeHost({port:0,backend:fixture()});t.after(()=>host.close());
 assert.equal((await fetch(host.url+'/claude/status',{headers:{Origin:'https://foreign.example'}})).status,403);
 const c=await connect(host);t.after(()=>c.socket.terminate());
 await new Promise((r,j)=>{const other=new WebSocket(host.url.replace('http:','ws:')+'/claude',{origin:host.url});other.on('error',()=>{});other.on('open',()=>j(new Error('Concurrent client accepted')));other.on('unexpected-response',(_,res)=>{assert.equal(res.statusCode,409);res.resume();other.terminate();r();});});
 c.send({type:'input/start',seq:1});const invalid=frame();invalid.writeFloatLE(NaN,0);c.socket.send(invalid);
 await c.wait(es=>es.some(e=>e.type==='error'));assert.match(c.events.find(e=>e.type==='error').message,/Invalid microphone/);
});
