import assert from "node:assert/strict";
import { test } from "node:test";
import { createRemoteOpenClawBackend,validateRemoteSettings } from "../scripts/openclaw-remote-backend.mjs";
import { runOwned } from "../scripts/claude-process.mjs";

const remote={url:"wss://gateway.example/",token:"private-gateway-token"};
const voiceAgent="huddle-voice";
const utterance=[{role:"user",content:"안녕하세요."}];
const deferred=()=>{let resolve,reject;const promise=new Promise((r,j)=>{resolve=r;reject=j;});return{promise,resolve,reject};};
function fixture(override=()=>{}, {probe,agent}={}){
  const calls=[];let runId;
  const sessions=new Map();
  const backend=createRemoteOpenClawBackend({remote:{...remote,agent},run:async(binary,args,options)=>{
    const method=args[0]==="gateway"?args[2]:binary;
    const params=method===binary?{}:JSON.parse(args[args.indexOf("--params")+1]);
    calls.push({method,params,args,options});
    if(method==="agent.wait"&&params.runId.startsWith("huddle-check-"))
      return JSON.stringify(probe?.()??{status:"timeout",runId:params.runId});
    const value=await override({method,params,options});if(value!==undefined)return JSON.stringify(value);
    if(method==="health")return JSON.stringify({ok:true,defaultAgentId:"main",secret:"never expose",agents:[{agentId:"main"},{agentId:voiceAgent,private:"data"}]});
    if(method==="sessions.create"){
      const sessionId=`gateway-session-${sessions.size+1}`;
      sessions.set(params.key,sessionId);
      return JSON.stringify({ok:true,key:params.key,sessionId,runStarted:false});
    }
    if(method==="tools.effective")return JSON.stringify({agentId:agent??voiceAgent,profile:"full",groups:[]});
    if(method==="sessions.reclaim")return JSON.stringify({ok:true,key:params.key,sessionId:sessions.get(params.key),placement:{state:"reclaimed"}});
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
  const {backend,calls}=fixture();const status=await backend.inspect();assert.equal(status.ready,true);assert.equal(status.agentId,voiceAgent);assert.equal(status.mode,"remote");
  assert.equal(JSON.stringify(status).includes("never expose"),false);assert.equal(JSON.stringify(status).includes(remote.token),false);
  const health=calls.find(c=>c.method==="health");assert.equal(health.options.env.OPENCLAW_GATEWAY_URL,remote.url);assert.equal(health.options.env.OPENCLAW_GATEWAY_TOKEN,remote.token);
  assert.equal(health.args.join(" ").includes(remote.token),false);assert.equal(health.options.env.OPENCLAW_GATEWAY_PASSWORD,"");
  assert.equal(calls.some(c=>c.args.includes("auth")||c.args.includes("--local")),false);
  assert.equal(calls.filter(c=>c.method==="agent").length,0);
  assert.equal(calls.filter(c=>c.method==="sessions.create").length,0);
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
  const session=await backend.openSession();
  await assert.rejects(session.reply(utterance),error=>!error.fatal&&/operator.write/.test(error.message));
  assert.equal(calls.some(c=>c.method==="chat.abort"),false);
  assert.equal((await backend.inspect()).ready,true);
});
test("one Gateway session is opened and reclaimed per call, with distinct runs for its utterances",async()=>{
  const {backend,calls}=fixture();
  const session=await backend.openSession();
  assert.equal(await session.reply(utterance),"안녕하세요.");
  const previous=[...utterance,{role:"assistant",content:"기존 답변"},{role:"user",content:"다시 인사"}];
  await session.reply(previous);
  await Promise.all([session.close(),session.close()]);
  await assert.rejects(session.reply(utterance),/종료됐습니다/);
  const starts=calls.filter(c=>c.method==="agent");
  const created=calls.filter(c=>c.method==="sessions.create");
  const reclaimed=calls.filter(c=>c.method==="sessions.reclaim");
  assert.equal(created.length,1);
  assert.equal(starts.length,2);
  assert.notEqual(starts[0].params.idempotencyKey,starts[1].params.idempotencyKey);
  assert.equal(reclaimed.length,1);
  assert.deepEqual(reclaimed[0].params,{key:created[0].params.key});
  for(const {params} of starts){
    assert.equal(params.agentId,voiceAgent);
    assert.equal(params.deliver,false);
    assert.equal(params.sessionKey,created[0].params.key);
    assert.equal(params.sessionId,undefined);
    assert.equal(params.modelRun,undefined);
    assert.equal(params.promptMode,undefined);
  }
  assert.match(starts[1].params.message,/다시 인사$/);
  assert.doesNotMatch(starts[1].params.message,/기존 답변|안녕하세요\./);
  const second=await backend.openSession();
  assert.notEqual(calls.filter(c=>c.method==="sessions.create")[1].params.key,created[0].params.key);
  await second.close();
});
test("a terminal promise to check later becomes an immediate answer without another Gateway run",async()=>{
  let response="네, 알아볼게요.";
  const {backend,calls}=fixture(({method})=>method==="agent.wait"?{
    status:"ok",terminalReply:{disposition:"visible",text:response},
  }:undefined);
  const question=[{role:"user",content:"슬랙 연결 가능해?"}];
  const session=await backend.openSession();
  assert.match(await session.reply(question),/이 통화에서 외부 서비스의 상태를 직접 확인할 수는 없어요/);
  const requests=()=>calls.filter(call=>call.method==="agent");
  assert.equal(requests().length,1);
  assert.match(requests()[0].params.message,/cannot send a follow-up/);
  response="OpenClaw는 슬랙 연동을 지원하지만, 현재 설정은 이 통화에서 확인할 수 없어요.";
  assert.equal(await session.reply(question),response);
  await session.close();
});
test("an agent with callable tools never receives a voice turn",async()=>{
  const {backend,calls}=fixture(({method})=>method==="tools.effective"
    ? {agentId:voiceAgent,groups:[{tools:[{id:"exec"}]}]}:undefined);
  await assert.rejects(backend.openSession(),/도구 사용을 차단/);
  assert.equal(calls.some(call=>call.method==="agent"),false);
  assert.deepEqual(calls.find(call=>call.method==="sessions.reclaim").params,
    {key:calls.find(call=>call.method==="sessions.create").params.key});
});
test("a configured MCP server is rejected before its tools are discovered",async()=>{
  const {backend,calls}=fixture(({method})=>method==="tools.effective"
    ? {agentId:voiceAgent,groups:[],notices:[{id:"mcp-not-yet-connected",servers:["fixture"]}]}:undefined);
  await assert.rejects(backend.openSession(),/도구 사용을 차단/);
  assert.equal(calls.some(call=>call.method==="agent"),false);
});
test("a local Gateway session without a worker workspace closes without a reclaim error",async()=>{
  let sessionKey;
  const {backend}=fixture(({method,params})=>{
    if(method==="sessions.create")sessionKey=params.key;
    if(method==="sessions.reclaim")return {ok:false,error:{type:"gateway_request_error",code:"INVALID_REQUEST",
      message:"sessions.reclaim requires the session-owned worktree, repository workspace, or device folder"}};
    if(method==="sessions.describe")return {session:{key:sessionKey,sessionId:"gateway-session-1"}};
  });
  const session=await backend.openSession();
  await session.close();
});
test("a completed Worker admission failure reports the right layer without replay or a cancellation request",async()=>{
  const {backend,calls}=fixture(({method})=>method==="agent.wait"?{
    status:"error",error:`Worker session source is unavailable or changed during admission; retry. | invalid_state ${remote.token}`,
  }:undefined);
  const session=await backend.openSession();
  await assert.rejects(session.reply(utterance),error=>/Worker.*세션/.test(error.message)&&!error.message.includes(remote.token));
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
  const session=await backend.openSession();let settled=false;const reply=session.reply([{role:"user",content:"long reply"}],controller.signal).finally(()=>{settled=true;});
  const rejection=assert.rejects(reply,/speech started/);await waiting.promise;controller.abort(new Error("speech started"));
  await new Promise(r=>setImmediate(r));assert.equal(settled,false);assert.equal(cancelled,true);
  const start=calls.find(c=>c.method==="agent").params,abort=calls.find(c=>c.method==="chat.abort").params;
  assert.deepEqual(abort,{agentId:voiceAgent,sessionKey:start.sessionKey,runId:start.idempotencyKey});
  confirm.resolve();await rejection;assert.equal((await backend.inspect()).ready,true);
});
test("speech during submission waits for acknowledgement and cancels that accepted run",async()=>{
  const submitting=deferred(),accept=deferred(),controller=new AbortController();let cancelling=false;
  const {backend,calls}=fixture(async({method,params})=>{
    if(method==="agent"){submitting.resolve();await accept.promise;return{status:"accepted",runId:params.idempotencyKey};}
    if(method==="chat.abort"){cancelling=true;return{ok:true,aborted:true};}
    if(method==="agent.wait"){assert.equal(cancelling,true);return{status:"error"};}
  });
  const session=await backend.openSession();const pending=assert.rejects(session.reply(utterance,controller.signal),/new speech/);
  await submitting.promise;controller.abort(new Error("new speech"));assert.equal(cancelling,false);accept.resolve();await pending;
  assert.equal(calls.filter(c=>c.method==="chat.abort").length,1);
});
test("an unconfirmed remote stop blocks further requests and becomes a fatal session error",async()=>{
  let stopped=false;const {backend,calls}=fixture(async({method})=>{
    if(method==="agent.wait")return{status:"timeout"};
    if(method==="chat.abort"){stopped=true;return{ok:true,aborted:false};}
  });
  const session=await backend.openSession();await assert.rejects(session.reply(utterance,new AbortController().signal),error=>error.fatal===true&&/종료/.test(error.message));
  assert.equal(stopped,true);assert.equal((await backend.inspect()).ready,false);
  const before=calls.length;await assert.rejects(session.reply(utterance),/종료/);await session.close();assert.equal(calls.length,before);
});
test("remote authentication errors are sanitized and an already aborted request sends nothing",async()=>{
  const rejected=fixture(()=>{throw new Error(remote.token);});const status=await rejected.backend.inspect();assert.equal(status.ready,false);assert.equal(JSON.stringify(status).includes(remote.token),false);
  const {backend,calls}=fixture();const session=await backend.openSession();
  const controller=new AbortController();controller.abort(new Error("already stopped"));const before=calls.length;
  await assert.rejects(session.reply(utterance,controller.signal),/already stopped/);assert.equal(calls.length,before);
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
  const missing=fixture(({method})=>method==="health"?{ok:true,defaultAgentId:"main",agents:[{agentId:"main"}]}:undefined);
  assert.match((await missing.backend.inspect()).error,/전용 Huddle 에이전트/);
  const single=fixture(({method})=>method==="health"?{ok:true,agents:[{agentId:"only"}]}:undefined,{agent:"only"});
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
 const session=await backend.openSession();await assert.rejects(session.reply(utterance),error=>error.fatal===true);
 assert.equal(calls.filter(c=>c.method==="agent").length,1);
 assert.equal(calls.some(c=>c.method==="chat.abort"&&c.params.runId==="foreign-run"),false);
 assert.equal((await backend.inspect()).ready,false);
});
