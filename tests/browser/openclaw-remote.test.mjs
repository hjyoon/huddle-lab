// Real browser capture/VAD/PCM with the remote backend's RPC lifetime.
// Gateway replies and speech engines are fixtures; no remote inference here.
import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { createAiHost } from "../../scripts/ai-host.mjs";
import { createRemoteOpenClawBackend } from "../../scripts/openclaw-remote-backend.mjs";
import { providerFixtures } from "../fixtures/ai-backends.mjs";

test("remote inference barge-in cancels the owned Gateway run before submitting the next voice turn",{timeout:25000},async t=>{
 const events=[];let firstRun,active,sessionKey,utterance=0;
 const backend=createRemoteOpenClawBackend({remote:{url:"wss://gateway.example/",token:"test-token"},run:async(binary,args,options)=>{
  if(args[0]!=="gateway")return binary==="say"?"Yuna ko_KR":"{}";
  const method=args[2],params=JSON.parse(args[args.indexOf("--params")+1]);events.push({method,params});
  if(method==="health")return JSON.stringify({ok:true,defaultAgentId:"main",agents:[{agentId:"main"},{agentId:"huddle-voice"}]});
  if(method==="sessions.create"){
   assert.equal(sessionKey,undefined,"one Gateway session belongs to the browser call");
   sessionKey=params.key;
   return JSON.stringify({ok:true,key:sessionKey,sessionId:"gateway-voice-session",runStarted:false});
  }
  if(method==="tools.effective"){
   assert.equal(params.sessionKey,sessionKey);
   return JSON.stringify({agentId:"huddle-voice",profile:"full",groups:[]});
  }
  if(method==="agent"){
   assert.equal(params.sessionKey,sessionKey);assert.equal(params.deliver,false);
   assert.equal(active,undefined,"the previous Gateway run must be terminal");active=params.idempotencyKey;firstRun??=active;
   return JSON.stringify({status:"accepted",runId:active});
  }
  if(method==="chat.abort"){
   assert.equal(params.sessionKey,sessionKey);
   assert.equal(params.runId,firstRun);assert.equal(params.runId,active);active=undefined;
   return JSON.stringify({ok:true,aborted:true,runIds:[params.runId]});
  }
  if(method==="agent.wait"){
   if(params.runId.startsWith("huddle-check-"))return JSON.stringify({status:"timeout",runId:params.runId});
   if(params.runId===firstRun){
    if(!active)return JSON.stringify({status:"error"});
    await new Promise((_,reject)=>options.signal.addEventListener("abort",()=>reject(options.signal.reason),{once:true}));
   }
   active=undefined;return JSON.stringify({status:"ok",terminalReply:{disposition:"visible",text:"두 번째 응답"}});
  }
  if(method==="sessions.reclaim"){
   assert.equal(params.key,sessionKey);assert.equal(active,undefined);
   return JSON.stringify({ok:true,key:sessionKey,sessionId:"gateway-voice-session",placement:{state:"reclaimed"}});
  }
  throw new Error("Unexpected RPC");
 }});
 backend.transcribe=async()=>++utterance===1?"첫 번째 질문":"두 번째 질문";
 backend.synthesize=async()=>Float32Array.from({length:48000/3},(_,i)=>Math.sin(2*Math.PI*440*i/48000)*.1);
 const host=await createAiHost({port:0,...providerFixtures(),openclawRemote:{backend}});t.after(()=>host.close());
 const browser=await chromium.launch({channel:process.env.HUDDLE_BROWSER_CHANNEL??"chrome",headless:true,args:["--autoplay-policy=no-user-gesture-required","--mute-audio"]});t.after(()=>browser.close());
 const page=await browser.newPage();const errors=[];page.on("pageerror",error=>errors.push(error.message));
 await page.addInitScript(()=>{
  const probe=window.probe={contexts:[],tracks:[],frames:0,buffers:0};
  const C=AudioContext;window.AudioContext=class extends C{constructor(...args){super(...args);probe.contexts.push(this);const make=this.createBufferSource.bind(this);this.createBufferSource=()=>{probe.buffers++;return make();};}};
  const W=AudioWorkletNode;window.AudioWorkletNode=class extends W{constructor(...args){super(...args);if(args[1]==="buzz-huddle-capture"){this.port.addEventListener("message",()=>probe.frames++);this.port.start();}}};
  navigator.mediaDevices.getUserMedia=async()=>{
   const context=probe.virtual=new AudioContext({sampleRate:48000}),osc=context.createOscillator(),gain=probe.gain=context.createGain(),destination=context.createMediaStreamDestination();
   gain.gain.value=0;osc.connect(gain).connect(destination);osc.start();await context.resume();probe.tracks.push(...destination.stream.getTracks());return destination.stream;
  };
 });
 await page.goto(host.url);await page.locator("#provider").selectOption("openclaw");await page.locator("#openclaw-mode").selectOption("remote");
 await page.locator("#remote-url").fill("wss://gateway.example/");await page.locator("#remote-secret").fill("test-token");await page.locator("#remote-apply").click();
 await page.waitForFunction(()=>!document.getElementById("start").disabled);await page.locator("#start").click();await page.waitForFunction(()=>document.getElementById("status").textContent==="통화 중");
 const speak=async()=>{const frames=await page.evaluate(()=>{probe.gain.gain.value=.2;return probe.frames;});await page.waitForFunction(start=>probe.frames>start+12,frames);await page.evaluate(()=>probe.gain.gain.value=0);};
 await speak();
 const waitFor=async predicate=>{const end=Date.now()+5000;while(!predicate()){if(Date.now()>end)throw new Error("RPC event timeout");await new Promise(r=>setTimeout(r,10));}};
 await waitFor(()=>events.some(e=>e.method==="agent.wait"&&e.params.runId===firstRun));
 assert.equal(await page.evaluate(()=>probe.buffers),0);await speak();
 await page.waitForFunction(()=>document.getElementById("transcripts").textContent.includes("두 번째 응답")&&document.getElementById("activity").textContent==="듣는 중");
 assert.equal(events.filter(e=>e.method==="agent").length,2);
 assert.ok(events.findIndex(e=>e.method==="chat.abort")<events.findLastIndex(e=>e.method==="agent"));
 assert.ok(await page.evaluate(()=>probe.buffers)>0);assert.equal(await page.locator("#error").textContent(),"");
 await page.locator("#stop").click();await page.waitForFunction(()=>document.getElementById("status").textContent==="대기 중");await page.evaluate(()=>probe.virtual.close());
 await waitFor(()=>events.some(e=>e.method==="sessions.reclaim"));
 assert.equal(events.filter(e=>e.method==="sessions.create").length,1);
 assert.equal(events.filter(e=>e.method==="sessions.reclaim").length,1);
 assert.equal(await page.evaluate(()=>probe.contexts.every(c=>c.state==="closed")&&probe.tracks.every(t=>t.readyState==="ended")),true);
 assert.deepEqual(errors,[]);
});
