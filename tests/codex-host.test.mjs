import assert from "node:assert/strict";
import { test } from "node:test";
import { WebSocket } from "ws";
import { createCodexHost } from "../scripts/codex-host.mjs";

function fixture() {
  const calls = [], subscribers = new Set(); let closed = 0;
  return { calls, get closed() { return closed; }, emit(message) { for (const fn of subscribers) fn(message); },
    async createRpc() { return {
      subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); },
      async request(method, params) {
        calls.push({ method, params });
        if (method === "account/read") return { account: { type: "chatgpt" } };
        if (method === "thread/start") return { thread: { id: "owned" } };
        return {};
      }, async close() { closed++; subscribers.clear(); },
    }; },
  };
}
async function client(host) {
  const ws = new WebSocket(host.url.replace("http:", "ws:") + "/codex", { origin: host.url });
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  let id = 0; const pending = new Map();
  ws.on("message", (raw) => { const value = JSON.parse(raw); const finish = pending.get(value.id); if (finish) { pending.delete(value.id); finish(value); } });
  return { ws, request(method, params = {}) { return new Promise((resolve) => { const key = ++id; pending.set(key, resolve); ws.send(JSON.stringify({ id:key,method,params })); }); } };
}
test("Codex host owns a read-only thread and limits browser requests to its voice session", async (t) => {
  const f = fixture(), host = await createCodexHost({ port:0, createRpc: f.createRpc });
  t.after(() => host.close());
  const status = await (await fetch(host.url + "/codex/status")).json();
  assert.equal(status.ready, true); assert.equal(status.mode, "read-only");
  const c = await client(host); t.after(() => c.ws.terminate());
  assert.deepEqual((await c.request("voice/open")).result, { threadId:"owned",mode:"read-only" });
  const thread = f.calls.find((call) => call.method === "thread/start").params;
  assert.equal(thread.sandbox,"read-only"); assert.equal(thread.ephemeral,true);
  assert.ok((await c.request("thread/realtime/start", { threadId:"other",transport:{type:"webrtc",sdp:"offer"} })).error);
  assert.ok((await c.request("turn/start", { threadId:"owned",input:[] })).error);
  assert.ok((await c.request("thread/realtime/start", { threadId:"owned",transport:{type:"webrtc",sdp:"offer"},model:"untrusted" })).result);
  const start = f.calls.find((call) => call.method === "thread/realtime/start").params;
  assert.equal(start.model,undefined); assert.equal(start.version,"v3"); assert.equal(start.clientManagedHandoffs,false);
  f.emit({method:"turn/started",params:{threadId:"owned",turn:{id:"turn"}}});
  await c.request("voice/interrupt",{threadId:"owned"});
  assert.ok(f.calls.some((c) => c.method === "turn/interrupt" && c.params.turnId === "turn"));
  assert.ok((await c.request("voice/close")).result);
  assert.ok(f.calls.findIndex((c) => c.method === "thread/realtime/stop") < f.calls.findIndex((c) => c.method === "thread/unsubscribe"));
  assert.equal((await (await fetch(host.url + "/codex/status")).json()).busy,false);
});
test("Codex host rejects foreign origins and simultaneous clients", async (t) => {
  const f = fixture(), host = await createCodexHost({port:0,createRpc:f.createRpc}); t.after(() => host.close());
  assert.equal((await fetch(host.url + "/codex/status",{headers:{Origin:"https://foreign.example"}})).status,403);
  const reject = (origin, code) => new Promise((resolve,reject) => {
    const ws = new WebSocket(host.url.replace("http:","ws:")+"/codex",{origin});
    ws.on("error",()=>{}); ws.on("unexpected-response",(_,response)=>{assert.equal(response.statusCode,code);response.resume();ws.terminate();resolve();});
    ws.on("open",()=>{ws.terminate();reject(new Error("Unexpected connection"));});
  });
  await reject("https://foreign.example",403);
  const c = await client(host); t.after(()=>c.ws.terminate());
  await reject(host.url,409);
});

test("a disconnected browser keeps its seat until a pending realtime start settles", async(t)=>{
 const f=fixture();let release,started;
 const startSeen=new Promise(r=>{started=r;});
 const createRpc=async()=>{
  const rpc=await f.createRpc();return{...rpc,request(method,params){
   if(method==='thread/realtime/start'){f.calls.push({method,params});started();return new Promise(r=>{release=r;});}
   return rpc.request(method,params);
  }};
 };
 const host=await createCodexHost({port:0,createRpc});t.after(()=>host.close());
 const c=await client(host);await c.request('voice/open');
 void c.request('thread/realtime/start',{threadId:'owned',transport:{type:'webrtc',sdp:'offer'}});
 await startSeen;
 const gone=new Promise(r=>c.ws.once('close',r));c.ws.terminate();await gone;
 assert.equal((await(await fetch(host.url+'/codex/status')).json()).busy,true);
 assert.equal(f.calls.some(c=>c.method==='thread/realtime/stop'),false);
 release({});
 await new Promise((resolve,reject)=>{
  const limit=setTimeout(()=>reject(new Error('Host did not release its seat')),3000);
  const poll=async()=>{if(!(await(await fetch(host.url+'/codex/status')).json()).busy){clearTimeout(limit);resolve();}else setTimeout(poll,10);};void poll();
 });
 assert.ok(f.calls.some(c=>c.method==='thread/realtime/stop'));
 assert.ok(f.calls.some(c=>c.method==='thread/unsubscribe'));
});
