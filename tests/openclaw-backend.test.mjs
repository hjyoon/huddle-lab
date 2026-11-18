import assert from "node:assert/strict";
import { test } from "node:test";
import { createLocalOpenClawBackend } from "../scripts/openclaw-backend.mjs";
const envelope=text=>JSON.stringify({ok:true,capability:'model.run',transport:'local',outputs:[{text}]},null,2);
test('OpenClaw uses tool-free local inference, honors configured agent/model and reads JSON output',async()=>{
 let captured;const backend=createLocalOpenClawBackend({agent:'voice',modelRef:'provider/model',run:async(binary,args,options)=>{
  assert.equal(binary,'openclaw');if(args.includes('--help'))return'--local --json --prompt';captured={args,options};return envelope('안녕하세요.');
 }});
 assert.equal(await backend.reply([{role:'user',content:'hello'}],new AbortController().signal),'안녕하세요.');
 assert.deepEqual(captured.args.slice(0,5),['infer','model','run','--local','--json']);assert.ok(captured.args.includes('voice'));assert.ok(captured.args.includes('provider/model'));
 assert.equal(captured.args.includes('--deliver'),false);assert.equal(captured.args.includes('--channel'),false);assert.match(captured.args.at(-1),/hello/);
});
test('OpenClaw uses stdin prompts when supported by the installed CLI',async()=>{
 let request;const backend=createLocalOpenClawBackend({run:async(_,args,options)=>{if(args.includes('--help'))return'--local --json --prompt-stdin';request={args,options};return envelope('answer');}});
 await backend.reply([{role:'user',content:'private utterance'}],new AbortController().signal);
 assert.ok(request.args.includes('--prompt-stdin'));assert.equal(request.args.some(a=>a.includes('private utterance')),false);assert.match(request.options.input,/private utterance/);
});
test('OpenClaw rejects failed, empty and incompatible CLI responses',async()=>{
 for(const output of [JSON.stringify({ok:false,error:'authentication missing'}),envelope('')]){
  const backend=createLocalOpenClawBackend({run:async(_,args)=>args.includes('--help')?'--local --json --prompt':output});
  await assert.rejects(backend.reply([],new AbortController().signal),/authentication missing|no spoken text/);
 }
 const backend=createLocalOpenClawBackend({run:async()=> 'unsupported CLI'});await assert.rejects(backend.reply([],new AbortController().signal),/does not support/);
});
test('OpenClaw readiness reuses speech engines without requiring Claude authentication',async()=>{
 const binaries=[];const backend=createLocalOpenClawBackend({run:async(binary,args)=>{
  binaries.push(binary);
  if(args[0]==='--version')return'OpenClaw test';
  if(args.includes('--help'))return'--local --json --prompt';
  if(args.includes('auth'))return JSON.stringify({agentId:'main',resolvedDefault:'provider/model',auth:{missingProvidersInUse:[]},secret:'must not reach browser'});
  if(binary==='say')return'Yuna ko_KR';return'{}';
 }});
 const status=await backend.inspect();assert.equal(status.ready,true);assert.equal(status.modelName,'provider/model');assert.equal(status.tools,false);assert.equal(status.secret,undefined);assert.equal(binaries.includes('claude'),false);
});
test('an already cancelled OpenClaw request does not invoke the CLI',async()=>{
 const abort=new AbortController();abort.abort(new Error('cancelled before launch'));let launched=false;
 const backend=createLocalOpenClawBackend({run:async()=>{launched=true;return'';}});
 await assert.rejects(backend.reply([],abort.signal),/cancelled before launch/);assert.equal(launched,false);
});
