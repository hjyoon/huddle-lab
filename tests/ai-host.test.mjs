import assert from "node:assert/strict";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WebSocket } from "ws";
import { createAiHost } from "../scripts/ai-host.mjs";
import { createOpenClawRemoteStore } from "../scripts/openclaw-remote-store.mjs";
import { providerFixtures } from "./fixtures/ai-backends.mjs";
async function socket(url,origin){const ws=new WebSocket(url,{origin});await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j);});return ws;}
const message=(ws)=>new Promise(r=>ws.once('message',raw=>r(JSON.parse(raw))));
test('AI selector exposes all providers and trusts only its own origin on child hosts',async t=>{
 const f=providerFixtures(),host=await createAiHost({port:0,...f});t.after(()=>host.close());
 assert.deepEqual(await(await fetch(host.url+'/api/providers')).json(),[{id:'codex',name:'Codex'},{id:'claude',name:'Claude'},{id:'openclaw',name:'OpenClaw'},{id:'hermes',name:'Hermes'}]);
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

test('Hermes status and PCM requests route to its own backend',async t=>{
 const f=providerFixtures(),host=await createAiHost({port:0,...f});t.after(()=>host.close());
 const metadata=await(await fetch(host.url+'/api/providers/hermes')).json();assert.equal(metadata.ready,true);assert.equal(metadata.id,'hermes');assert.equal(metadata.name,'Hermes');
 const client=await socket(metadata.wsUrl,host.url);t.after(()=>client.terminate());const events=[];
 client.on('message',(raw,binary)=>events.push(binary?{type:'audio',seq:raw.readUInt32LE(0)}:JSON.parse(raw)));
 const wait=async(predicate)=>{const end=Date.now()+3000;while(!predicate()){if(Date.now()>end)throw new Error('Hermes event timeout');await new Promise(r=>setTimeout(r,5));}};
 client.send(JSON.stringify({type:'voice/open'}));await wait(()=>events.some(e=>e.type==='voice/ready'));
 client.send(JSON.stringify({type:'input/start',seq:1}));for(let i=0;i<5;i++)client.send(Buffer.alloc(3840));client.send(JSON.stringify({type:'input/commit',seq:1}));
 await wait(()=>events.some(e=>e.type==='response-ended'));assert.equal(f.calls.hermesReplies,1);assert.equal(f.calls.openclawReplies,0);
 assert.ok(events.some(e=>e.type==='response-started'&&e.responseId.startsWith('hermes:')));
 assert.ok(events.some(e=>e.type==='transcript'&&e.speaker==='assistant'&&e.text==='Hermes fixture response'));
});

test('remote UI settings require same-origin JSON, omit credentials in reads and lock during a call',async t=>{
 const f=providerFixtures(),host=await createAiHost({port:0,...f,openclawRemote:{backend:f.openclaw.backend}});t.after(()=>host.close());
 const path=host.url+'/api/providers/openclaw/remote';
 const settings={url:'wss://remote.example/',token:'never-echo-this-token',agent:'main'};
 const save=(value,origin=host.url)=>fetch(path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(value)});
 assert.equal((await save(settings,'https://foreign.example')).status,403);
 assert.equal((await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(settings)})).status,403);
 assert.equal((await save({...settings,url:'ws://remote.example'})).status,400);
 const oversized=await save({...settings,token:'x'.repeat(13000)});assert.equal(oversized.status,400);
 const applied=await save(settings);assert.equal(applied.status,200);assert.equal((await applied.text()).includes(settings.token),false);
 const config=await(await fetch(path)).json();assert.deepEqual(config,{url:settings.url,agent:'main',configured:true,hasCredentials:true,authType:'token'});
 assert.equal((await save({url:'wss://different.example',agent:'main',authType:'token',reuseSaved:true})).status,400);
 assert.equal((await save({url:settings.url,agent:'alternate',authType:'token',reuseSaved:true})).status,200);
 const local=await(await fetch(host.url+'/api/providers/openclaw')).json(),remote=await(await fetch(host.url+'/api/providers/openclaw?mode=remote')).json();
 assert.equal(remote.mode,'remote');assert.notEqual(remote.wsUrl,local.wsUrl);assert.equal(JSON.stringify(remote).includes(settings.token),false);
 const client=await socket(remote.wsUrl,host.url);t.after(()=>client.terminate());let next=message(client);client.send(JSON.stringify({type:'voice/open'}));await next;
 assert.equal((await save({...settings,url:'wss://different.example'})).status,409);
 assert.equal((await fetch(path,{method:'DELETE',headers:{Origin:host.url}})).status,409);
 next=message(client);client.send(JSON.stringify({type:'voice/close'}));await next;
 const changed=await save({...settings,url:'wss://different.example'});assert.equal(changed.status,200);
 const updated=await(await fetch(host.url+'/api/providers/openclaw?mode=remote')).json();assert.notEqual(updated.wsUrl,remote.wsUrl);
 assert.equal((await fetch(host.url+'/api/providers/openclaw?mode=unknown')).status,400);
});

test('saved remote authentication survives server restart and deletion survives another restart',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'huddle-remote-store-test-'));
 const f=providerFixtures();
 const start=()=>createAiHost({port:0,...f,remoteStore:createOpenClawRemoteStore(directory),openclawRemote:{backend:f.openclaw.backend}});
 let host=await start();
 t.after(async()=>{await host.close();await rm(directory,{recursive:true,force:true});});
 const path=()=>`${host.url}/api/providers/openclaw/remote`;
 const settings={url:'wss://remote.example/',password:'saved-test-password',agent:'main'};
 const saved=await fetch(path(),{method:'POST',headers:{Origin:host.url,'Content-Type':'application/json'},body:JSON.stringify(settings)});
 assert.equal(saved.status,200);
 const file=join(directory,'openclaw-remote.json');
 if(process.platform!=='win32')assert.equal((await lstat(file)).mode&0o777,0o600);
 assert.equal((await createOpenClawRemoteStore(directory).load()).password,settings.password);
 await host.close();host=await start();
 const restored=await(await fetch(path())).text();
 assert.equal(JSON.parse(restored).hasCredentials,true);
 assert.equal(JSON.parse(restored).url,settings.url);
 assert.equal(restored.includes(settings.password),false);
 const reveal=origin=>fetch(path()+'/reveal',{method:'POST',headers:{...(origin?{Origin:origin}:{}),'Content-Type':'application/json'},body:'{}'});
 assert.equal((await fetch(path()+'/reveal')).status,405);
 assert.equal((await reveal()).status,403);
 assert.equal((await reveal('https://foreign.example')).status,403);
 const revealed=await reveal(host.url);assert.equal(revealed.status,200);assert.equal(revealed.headers.get('cache-control'),'no-store');
 assert.deepEqual(await revealed.json(),{url:settings.url,authType:'password',secret:settings.password});
 assert.equal((await fetch(host.url+'/.huddle-runtime/openclaw-remote.json')).status,404);
 assert.equal((await(await fetch(host.url+'/api/providers/openclaw?mode=remote')).json()).ready,true);
 assert.equal((await fetch(path(),{method:'DELETE',headers:{Origin:'https://foreign.example'}})).status,403);
 assert.equal((await fetch(path(),{method:'DELETE',headers:{Origin:host.url}})).status,200);
 assert.equal((await reveal(host.url)).status,404);
 assert.equal((await(await fetch(host.url+'/api/providers/openclaw?mode=remote')).json()).ready,false);
 await assert.rejects(lstat(file),{code:'ENOENT'});
 await host.close();host=await start();
 assert.equal((await(await fetch(path())).json()).hasCredentials,false);
});

test('Claude login is a same-origin POST proxied to the Claude backend',async t=>{
 const f=providerFixtures();let logins=0;
 f.claude.backend.inspect=async()=>({ready:false,needsLogin:true,error:'signed out',workspace:process.cwd()});
 f.claude.backend.login=async()=>{logins++;};
 const host=await createAiHost({port:0,...f});t.after(()=>host.close());
 const status=await(await fetch(host.url+'/api/providers/claude')).json();
 assert.equal(status.needsLogin,true);assert.equal(status.canLogin,true);
 assert.equal((await(await fetch(host.url+'/api/providers/codex')).json()).canLogin,false);
 const path=host.url+'/api/providers/claude/login',post=(headers)=>fetch(path,{method:'POST',headers,body:'{}'});
 assert.equal((await fetch(path)).status,405);
 assert.equal((await post({'Content-Type':'application/json'})).status,403);
 assert.equal((await post({Origin:'https://foreign.example','Content-Type':'application/json'})).status,403);
 assert.equal(logins,0);
 const ok=await post({Origin:host.url,'Content-Type':'application/json'});
 assert.equal(ok.status,200);assert.equal(logins,1);
 f.claude.backend.login=async()=>{throw new Error('browser login failed');};
 const failed=await post({Origin:host.url,'Content-Type':'application/json'});
 assert.equal(failed.status,400);assert.equal((await failed.json()).error,'browser login failed');
});
