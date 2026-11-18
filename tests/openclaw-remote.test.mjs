import assert from "node:assert/strict";
import { test } from "node:test";
import { createRemoteOpenClawBackend,validateRemoteSettings } from "../scripts/openclaw-remote-backend.mjs";
import { runOwned } from "../scripts/claude-process.mjs";

const remote={url:"wss://gateway.example/",token:"private-gateway-token"};
const deferred=()=>{let resolve,reject;const promise=new Promise((r,j)=>{resolve=r;reject=j;});return{promise,resolve,reject};};
function fixture(override=()=>{}, {probe}={}){
  const calls=[];let runId;
  const backend=createRemoteOpenClawBackend({remote,run:async(binary,args,options)=>{
    const method=args[0]==="gateway"?args[2]:binary;
    const params=method===binary?{}:JSON.parse(args[args.indexOf("--params")+1]);
    calls.push({method,params,args,options});
    if(method==="agent.wait"&&params.runId.startsWith("huddle-check-"))
      return JSON.stringify(probe?.()??{status:"timeout",runId:params.runId});
    const value=await override({method,params,options});if(value!==undefined)return JSON.stringify(value);
    if(method==="health")return JSON.stringify({ok:true,defaultAgentId:"main",secret:"never expose",agents:[{agentId:"main",private:"data"}]});
    if(method==="agent"){runId=params.idempotencyKey;return JSON.stringify({status:"accepted",runId});}
    if(method==="agent.wait")return JSON.stringify({status:"ok",terminalReply:{disposition:"visible",text:"안녕하세요."}});
    if(method==="chat.abort")return JSON.stringify({ok:true,aborted:true,runIds:[runId]});
    if(binary==="say")return"Yuna ko_KR";
    return"{}";
  }});
  return{backend,calls};
}
test("remote settings reject insecure remote addresses, embedded credentials and CLI-shaped input",()=>{
  for(const url of ["https://gateway.example","ws://gateway.example","wss://user:secret@gateway.example","wss://gateway.example/?token=x","wss://gateway.example/#x","--help"])
    assert.throws(()=>validateRemoteSettings({...remote,url}));
  assert.throws(()=>validateRemoteSettings({...remote,extra:"--deliver"}));
  assert.throws(()=>validateRemoteSettings({...remote,password:"both"}));
  assert.throws(()=>validateRemoteSettings({...remote,token:""}));
  assert.throws(()=>validateRemoteSettings({...remote,agent:"../main"}));
  assert.equal(validateRemoteSettings({...remote,url:"ws://127.0.0.1:18789"}).url,"ws://127.0.0.1:18789/");
  assert.equal(validateRemoteSettings({url:remote.url,password:"secret",agent:"Voice"}).agent,"voice");
});
test("remote readiness uses Gateway health and local speech, keeps credentials out of argv and browser metadata",async()=>{
  const {backend,calls}=fixture();const status=await backend.inspect();assert.equal(status.ready,true);assert.equal(status.agentId,"main");assert.equal(status.mode,"remote");
  assert.equal(JSON.stringify(status).includes("never expose"),false);assert.equal(JSON.stringify(status).includes(remote.token),false);
  const health=calls.find(c=>c.method==="health");assert.equal(health.options.env.OPENCLAW_GATEWAY_URL,remote.url);assert.equal(health.options.env.OPENCLAW_GATEWAY_TOKEN,remote.token);
  assert.equal(health.args.join(" ").includes(remote.token),false);assert.equal(health.options.env.OPENCLAW_GATEWAY_PASSWORD,"");
  assert.equal(calls.some(c=>c.args.includes("auth")||c.args.includes("--local")),false);
  assert.equal(calls.filter(c=>c.method==="agent").length,0);
  assert.match(calls.find(c=>c.method==="agent.wait").params.runId,/^huddle-check-/);
});
test("read access alone doesn't enable calls, and a write-scope approval retry recovers readiness",async()=>{
  let approved=false;
  const {backend,calls}=fixture(undefined,{probe:()=>approved?{status:"timeout"}:{ok:false,error:{type:"gateway_transport_error",reason:"pairing required"}}});
  const before=await backend.inspect();assert.equal(before.ready,false);assert.match(before.error,/operator.write/);
  assert.equal(calls.some(c=>c.method==="agent"),false);
  approved=true;assert.equal((await backend.inspect()).ready,true);
});
test("an explicit agent rejection does not cancel a nonexistent run or lock later calls",async()=>{
  const {backend,calls}=fixture(({method})=>method==="agent"?{ok:false,error:{type:"gateway_request_error",code:"INVALID_REQUEST",message:"missing scope: operator.write"}}:undefined);
  await backend.inspect();
  await assert.rejects(backend.reply([]),error=>!error.fatal&&/operator.write/.test(error.message));
  assert.equal(calls.some(c=>c.method==="chat.abort"),false);
  assert.equal((await backend.inspect()).ready,true);
});
test("remote conversations use isolated tool-free model runs and the Gateway's completed reply",async()=>{
  const {backend,calls}=fixture();await backend.inspect();
  assert.equal(await backend.reply([{role:"user",content:"인사"}],new AbortController().signal),"안녕하세요.");
  await backend.reply([{role:"user",content:"다시 인사"}],new AbortController().signal);
  const starts=calls.filter(c=>c.method==="agent");assert.equal(starts.length,2);assert.notEqual(starts[0].params.sessionKey,starts[1].params.sessionKey);
  for(const {params} of starts){assert.equal(params.modelRun,true);assert.equal(params.promptMode,"none");assert.equal(params.cleanupBundleMcpOnRunEnd,true);assert.equal(params.deliver,undefined);assert.equal(params.sessionKey,`agent:main:explicit:${params.sessionId}`);}
});
test("a completed Worker admission failure reports the right layer without replay or a cancellation request",async()=>{
  const {backend,calls}=fixture(({method})=>method==="agent.wait"?{
    status:"error",error:`Worker session source is unavailable or changed during admission; retry. | invalid_state ${remote.token}`,
  }:undefined);
  await backend.inspect();
  await assert.rejects(backend.reply([]),error=>/Worker.*세션/.test(error.message)&&!error.message.includes(remote.token));
  assert.equal(calls.filter(call=>call.method==="agent").length,1);
  assert.equal(calls.some(call=>call.method==="chat.abort"),false);
});
test("barge-in waits for exact remote cancellation and terminal confirmation before settling",async()=>{
  const waiting=deferred(),confirm=deferred(),controller=new AbortController();let cancelled=false;
  const {backend,calls}=fixture(async({method,options})=>{
    if(method==="chat.abort"){cancelled=true;return{ok:true,aborted:true};}
    if(method==="agent.wait"){
      if(cancelled){await confirm.promise;return{status:"error"};}
      waiting.resolve();await new Promise((_,reject)=>options.signal.addEventListener("abort",()=>reject(options.signal.reason),{once:true}));
    }
  });
  await backend.inspect();let settled=false;const reply=backend.reply([{role:"user",content:"long reply"}],controller.signal).finally(()=>{settled=true;});
  const rejection=assert.rejects(reply,/speech started/);await waiting.promise;controller.abort(new Error("speech started"));
  await new Promise(r=>setImmediate(r));assert.equal(settled,false);assert.equal(cancelled,true);
  const start=calls.find(c=>c.method==="agent").params,abort=calls.find(c=>c.method==="chat.abort").params;
  assert.deepEqual(abort,{agentId:"main",sessionKey:start.sessionKey,runId:start.idempotencyKey});
  confirm.resolve();await rejection;assert.equal((await backend.inspect()).ready,true);
});
test("speech during submission waits for acknowledgement and cancels that accepted run",async()=>{
  const submitting=deferred(),accept=deferred(),controller=new AbortController();let cancelling=false;
  const {backend,calls}=fixture(async({method,params})=>{
    if(method==="agent"){submitting.resolve();await accept.promise;return{status:"accepted",runId:params.idempotencyKey};}
    if(method==="chat.abort"){cancelling=true;return{ok:true,aborted:true};}
    if(method==="agent.wait"){assert.equal(cancelling,true);return{status:"error"};}
  });
  await backend.inspect();const pending=assert.rejects(backend.reply([],controller.signal),/new speech/);
  await submitting.promise;controller.abort(new Error("new speech"));assert.equal(cancelling,false);accept.resolve();await pending;
  assert.equal(calls.filter(c=>c.method==="chat.abort").length,1);
});
test("an unconfirmed remote stop blocks further requests and becomes a fatal session error",async()=>{
  let stopped=false;const {backend,calls}=fixture(async({method})=>{
    if(method==="agent.wait")return{status:"timeout"};
    if(method==="chat.abort"){stopped=true;return{ok:true,aborted:false};}
  });
  await backend.inspect();await assert.rejects(backend.reply([],new AbortController().signal),error=>error.fatal===true&&/종료/.test(error.message));
  assert.equal(stopped,true);assert.equal((await backend.inspect()).ready,false);
  const before=calls.length;await assert.rejects(backend.reply([],new AbortController().signal),/종료/);assert.equal(calls.length,before);
});
test("remote authentication errors are sanitized and an already aborted request sends nothing",async()=>{
  const {backend,calls}=fixture(()=>{throw new Error(remote.token);});const status=await backend.inspect();assert.equal(status.ready,false);assert.equal(JSON.stringify(status).includes(remote.token),false);
  const controller=new AbortController();controller.abort(new Error("already stopped"));const before=calls.length;
  await assert.rejects(backend.reply([],controller.signal),/already stopped/);assert.equal(calls.length,before);
});
test("a CLI subprocess exit reports pairing without exposing its raw error or token",async()=>{
  const backend=createRemoteOpenClawBackend({remote,run:(_,args,options)=>{
    assert.equal(args[2],"health");
    const response={ok:false,error:{type:"gateway_transport_error",reason:"pairing required",message:remote.token}};
    return runOwned(process.execPath,["-e","console.log(process.argv[1]); process.exitCode=1",JSON.stringify(response)],options);
  }});
  const status=await backend.inspect();assert.equal(status.ready,false);
  assert.match(status.error,/기기 승인/);assert.equal(JSON.stringify(status).includes(remote.token),false);
});
test("connection status distinguishes rejected credentials and agent selection",async()=>{
  const rejected=fixture(({method})=>method==="health"?{ok:false,error:{details:{code:"AUTH_TOKEN_MISMATCH"},message:remote.token}}:undefined);
  assert.match((await rejected.backend.inspect()).error,/인증 정보를 거절/);
  const missing=fixture(({method})=>method==="health"?{ok:true,agents:[{agentId:"first"},{agentId:"second"}]}:undefined);
  assert.match((await missing.backend.inspect()).error,/기본 에이전트/);
  const single=fixture(({method})=>method==="health"?{ok:true,agents:[{agentId:"only"}]}:undefined);
  const status=await single.backend.inspect();assert.equal(status.ready,true);assert.equal(status.agentId,"only");
});
test("an HTTP 502 at WebSocket upgrade reports the status without reflecting the proxy body",async()=>{
 const response={ok:false,error:{type:"gateway_request_error",code:"UNAVAILABLE",message:`gateway rejected websocket upgrade (HTTP 502): <html>${remote.token}</html>`}};
 const {backend}=fixture(({method})=>method==="health"?response:undefined);
 const status=await backend.inspect();assert.equal(status.ready,false);assert.match(status.error,/HTTP 502/);
 assert.equal(status.error.includes(remote.token),false);
});
test("an ambiguous submission is never retried or allowed to leak a foreign run into cancellation",async()=>{
 const {backend,calls}=fixture(({method})=>method==="agent"?{status:"accepted",runId:"foreign-run"}:undefined);
 await backend.inspect();await assert.rejects(backend.reply([],new AbortController().signal),error=>error.fatal===true);
 assert.equal(calls.filter(c=>c.method==="agent").length,1);
 assert.equal(calls.some(c=>c.method==="chat.abort"&&c.params.runId==="foreign-run"),false);
 assert.equal((await backend.inspect()).ready,false);
});
