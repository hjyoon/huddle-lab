// Protocol/model/STT/TTS fixture with native Chrome capture/playback and local
// WebSocket. Actual local ASR/TTS are verified separately; no Claude inference.
import assert from "node:assert/strict";
import { before,after,test } from "node:test";
import { chromium } from "playwright";
import { createClaudeHost } from "../../scripts/claude-host.mjs";
let browser,host,calls=0,failModel=false;const signals=[];
before(async()=>{
 host=await createClaudeHost({port:0,backend:{
  async inspect(){return{ready:true,version:'test fixture (not Claude inference)',workspace:process.cwd()};},
  async transcribe(_,signal){signals.push(signal);return ++calls===1?'첫 번째 테스트':'바나나';},
  async reply(){if(failModel)throw new Error('Claude Code: Not logged in · Please run /login');return calls===1?'첫 번째 테스트 응답':'바나나';},
  async synthesize(){return Float32Array.from({length:48000*(calls===1?5:.5)},(_,i)=>Math.sin(i*2*Math.PI*440/48000)*.1);},
 }});
 browser=await chromium.launch({channel:process.env.HUDDLE_BROWSER_CHANNEL??'chrome',headless:true,args:['--autoplay-policy=no-user-gesture-required','--mute-audio']});
});
after(async()=>{await browser?.close();await host?.close();});
async function pageFor(t){
 const page=await browser.newPage();t.after(()=>page.close());const errors=[];page.on('pageerror',e=>errors.push(e.message));t.after(()=>assert.deepEqual(errors,[]));
 await page.addInitScript(()=>{
  const p=window.probe={contexts:[],tracks:[],buffers:0,stops:[],raw:0,loud:0,sockets:[],requests:[],stage:1};
  const C=AudioContext;window.AudioContext=class extends C{constructor(...args){super(...args);p.contexts.push(this);const create=this.createBufferSource.bind(this);this.createBufferSource=()=>{p.buffers++;const source=create(),stop=source.stop.bind(source);source.stop=(...args)=>{p.stops.push(performance.now());return stop(...args);};return source;};}};
  const W=AudioWorkletNode;window.AudioWorkletNode=class extends W{constructor(...args){super(...args);if(args[1]==='buzz-huddle-capture'){this.port.addEventListener('message',({data})=>{p.raw++;if(data.some(n=>Math.abs(n)>.05)){p.loud++;if(p.stage===2)p.onset??=performance.now();}});this.port.start();}}};
  const WS=WebSocket;window.WebSocket=class extends WS{constructor(...args){super(...args);p.sockets.push(this);}send(data){if(typeof data==='string')p.requests.push(JSON.parse(data));return super.send(data);}};
  navigator.mediaDevices.getUserMedia=async()=>{
   const context=p.virtual=new AudioContext({sampleRate:48000}),osc=context.createOscillator(),gain=p.gain=context.createGain(),destination=context.createMediaStreamDestination();
   gain.gain.value=0;osc.frequency.value=300;osc.connect(gain).connect(destination);osc.start();await context.resume();p.tracks.push(...destination.stream.getTracks());return destination.stream;
  };
 });
 await page.goto(host.url);await page.waitForFunction(()=>!document.getElementById('start').disabled);
 await page.locator('#start').click();await page.waitForFunction(()=>document.getElementById('status').textContent==='통화 중');return page;
}
async function speak(page){
 const baseline=await page.evaluate(()=>{probe.gain.gain.value=.2;return probe.loud;});
 await page.waitForFunction(base=>probe.loud>=base+12,baseline);await page.evaluate(()=>{probe.gain.gain.value=0;});
}
test('Claude adapter captures a turn, automatically barges in, fences stale PCM and keeps its socket', {timeout:25000},async t=>{
 const page=await pageFor(t);await speak(page);
 await page.waitForFunction(()=>document.getElementById('activity').textContent==='말하는 중'&&probe.buffers>=10);
 const stopped=await page.evaluate(()=>{probe.stage=2;probe.beforeStop=probe.stops.length;probe.gain.gain.value=.2;return probe.stops.length;});
 await page.waitForFunction(base=>probe.stops.length>base,stopped);
 const latency=await page.evaluate(()=>probe.stops[probe.beforeStop]-probe.onset);assert.ok(latency>=0&&latency<250,`Local interruption took ${latency} ms`);
 const buffers=await page.evaluate(()=>{
  const bytes=new ArrayBuffer(3844),view=new DataView(bytes);view.setUint32(0,1,true);for(let i=0;i<960;i++)view.setFloat32(4+i*4,.5,true);
  probe.sockets[0].dispatchEvent(new MessageEvent('message',{data:bytes}));probe.barrier=probe.raw+3;return probe.buffers;
 });
 await page.waitForFunction(()=>probe.raw>=probe.barrier);assert.equal(await page.evaluate(()=>probe.buffers),buffers);
 const loud=await page.evaluate(()=>probe.loud);await page.waitForFunction(base=>probe.loud>base+5,loud);await page.evaluate(()=>{probe.gain.gain.value=0;});
 await page.waitForFunction(()=>document.querySelectorAll('#transcripts li').length>=4&&document.getElementById('activity').textContent==='듣는 중');
 assert.equal(signals[0].aborted,true);assert.equal(calls,2);
 assert.equal(await page.evaluate(()=>probe.sockets.length),1);assert.equal(await page.evaluate(()=>probe.requests.some(r=>r.type==='voice/interrupt')),false);
 assert.match(await page.locator('#transcripts').textContent(),/바나나/);
 await page.locator('#mute').click();const barrier=await page.evaluate(()=>{probe.gain.gain.value=.2;return probe.raw+8;});await page.waitForFunction(b=>probe.raw>=b,barrier);assert.equal(calls,2);
 assert.equal(await page.evaluate(()=>probe.tracks.every(t=>!t.enabled)),true);
 await page.locator('#stop').click();await page.waitForFunction(()=>document.getElementById('status').textContent==='대기 중');await page.evaluate(()=>probe.virtual.close());
 assert.equal(await page.evaluate(()=>probe.contexts.every(c=>c.state==='closed')&&probe.tracks.every(t=>t.readyState==='ended')),true);
 assert.equal(await page.locator('#error').textContent(),'');
});
test('Claude login errors are displayed and release the native capture resources',{timeout:20000},async t=>{
 failModel=true;t.after(()=>{failModel=false;});const page=await pageFor(t);await speak(page);
 await page.waitForFunction(()=>document.getElementById('status').textContent==='연결 실패');
 assert.match(await page.locator('#error').textContent(),/Not logged in/);assert.equal(await page.evaluate(()=>probe.tracks.every(t=>t.readyState==='ended')),true);
 await page.evaluate(()=>probe.virtual.close());await page.waitForFunction(()=>probe.contexts.every(c=>c.state==='closed'));
});
