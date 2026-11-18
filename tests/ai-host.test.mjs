import assert from "node:assert/strict";
import { test } from "node:test";
import { WebSocket } from "ws";
import { createAiHost } from "../scripts/ai-host.mjs";
import { providerFixtures } from "./fixtures/ai-backends.mjs";
async function socket(url,origin){const ws=new WebSocket(url,{origin});await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j);});return ws;}
const message=(ws)=>new Promise(r=>ws.once('message',raw=>r(JSON.parse(raw))));
test('AI selector exposes all providers and trusts only its own origin on child hosts',async t=>{
 const f=providerFixtures(),host=await createAiHost({port:0,...f});t.after(()=>host.close());
 assert.deepEqual(await(await fetch(host.url+'/api/providers')).json(),[{id:'codex',name:'Codex'},{id:'claude',name:'Claude'},{id:'openclaw',name:'OpenClaw'}]);
 const c=await(await fetch(host.url+'/api/providers/codex')).json(),a=await(await fetch(host.url+'/api/providers/claude')).json();
 assert.equal(c.ready,true);assert.equal(a.ready,true);assert.notEqual(c.wsUrl,a.wsUrl);
 const code=await socket(c.wsUrl,host.url);t.after(()=>code.terminate());let response=message(code);code.send(JSON.stringify({id:1,method:'voice/open',params:{}}));assert.equal((await response).result.threadId,'codex-test-thread');
 response=message(code);code.send(JSON.stringify({id:2,method:'voice/close',params:{}}));await response;code.close();
 const claude=await socket(a.wsUrl,host.url);t.after(()=>claude.terminate());response=message(claude);claude.send(JSON.stringify({type:'voice/open'}));assert.equal((await response).type,'voice/ready');
 assert.equal((await fetch(host.url+'/api/providers/claude',{headers:{Origin:'https://foreign.example'}})).status,403);
 await new Promise((r,j)=>{const foreign=new WebSocket(c.wsUrl,{origin:'https://foreign.example'});foreign.on('error',()=>{});foreign.on('open',()=>j(new Error('Foreign origin was accepted')));foreign.on('unexpected-response',(_,res)=>{assert.equal(res.statusCode,403);res.resume();foreign.terminate();r();});});
});
test('closing the selector host cancels an active provider job before releasing its child hosts',async()=>{
 const f=providerFixtures();let started,signal;const working=new Promise(r=>{started=r;});
 f.claude.backend.transcribe=async(_,value)=>{signal=value;started();return new Promise(r=>value.addEventListener('abort',()=>r('late'),{once:true}));};
 const host=await createAiHost({port:0,...f});
 const metadata=await(await fetch(host.url+'/api/providers/claude')).json(),client=await socket(metadata.wsUrl,host.url);
 try{
  let next=message(client);client.send(JSON.stringify({type:'voice/open'}));await next;
  client.send(JSON.stringify({type:'input/start',seq:1}));for(let i=0;i<5;i++)client.send(Buffer.alloc(3840));client.send(JSON.stringify({type:'input/commit',seq:1}));
  await working;await host.close();assert.equal(signal.aborted,true);
 }finally{client.terminate();await host.close();}
});

 test('OpenClaw status and PCM requests route to its own backend',async t=>{
  const f=providerFixtures(),host=await createAiHost({port:0,...f});t.after(()=>host.close());
  const metadata=await(await fetch(host.url+'/api/providers/openclaw')).json();assert.equal(metadata.ready,true);assert.equal(metadata.id,'openclaw');
  const client=await socket(metadata.wsUrl,host.url);t.after(()=>client.terminate());const events=[];
  client.on('message',(raw,binary)=>events.push(binary?{type:'audio',seq:raw.readUInt32LE(0)}:JSON.parse(raw)));
  const wait=async(predicate)=>{const end=Date.now()+3000;while(!predicate()){if(Date.now()>end)throw new Error('OpenClaw event timeout');await new Promise(r=>setTimeout(r,5));}};
  client.send(JSON.stringify({type:'voice/open'}));await wait(()=>events.some(e=>e.type==='voice/ready'));
  client.send(JSON.stringify({type:'input/start',seq:1}));for(let i=0;i<5;i++)client.send(Buffer.alloc(3840));client.send(JSON.stringify({type:'input/commit',seq:1}));
  await wait(()=>events.some(e=>e.type==='response-ended'));assert.equal(f.calls.openclawReplies,1);assert.equal(f.calls.codexStarts,0);
  assert.ok(events.some(e=>e.type==='response-started'&&e.responseId.startsWith('openclaw:')));
  assert.ok(events.some(e=>e.type==='audio'&&e.seq===1));
 });
