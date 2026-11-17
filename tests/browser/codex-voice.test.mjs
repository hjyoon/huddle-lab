// Real browser WebRTC loopback. Synthetic audio and protocol fixture, no AI inference.
import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { chromium } from "playwright";
import { serveDemo } from "../../scripts/serve-demo.mjs";
let browser,host;
before(async()=>{
 host=await serveDemo(0);
 browser=await chromium.launch({channel:process.env.HUDDLE_BROWSER_CHANNEL??"chrome",headless:true,args:["--autoplay-policy=no-user-gesture-required"]});
});
after(async()=>{await browser?.close();if(host)await new Promise(r=>{host.server.close(r);host.server.closeAllConnections();});});
test("Codex provider sends/receives real RTP audio, reads canonical transcripts, interrupts and releases media",{timeout:25000},async(t)=>{
 const page=await browser.newPage();t.after(()=>page.close());const errors=[];page.on("pageerror",e=>errors.push(e.message));
 await page.goto(host.url);
 await page.evaluate(async()=>{
  const {createCodexVoiceProvider}=await import('/dist/codex-voice/index.js');
  const p=window.probe={events:[],controls:[],calls:[],contexts:[],peers:[],inputLevel:0,closed:0};
  const native=AudioContext;
  window.AudioContext=class extends native{constructor(...args){super(...args);p.contexts.push(this);}};
  const remote=new RTCPeerConnection();p.peers.push(remote);
  const context=new AudioContext({sampleRate:48000}),osc=context.createOscillator(),gain=context.createGain(),dest=context.createMediaStreamDestination();
  gain.gain.value=.15;osc.frequency.value=440;osc.connect(gain).connect(dest);osc.start();
  let notify;
  remote.ontrack=({track})=>{
   const source=context.createMediaStreamSource(new MediaStream([track])),analyser=context.createAnalyser();const silent=context.createGain();silent.gain.value=0;source.connect(analyser).connect(silent).connect(context.destination);
   p.poll=setInterval(()=>{const data=new Float32Array(analyser.fftSize);analyser.getFloatTimeDomainData(data);p.inputLevel=Math.max(p.inputLevel,...data.map(Math.abs));},20);
  };
  remote.ondatachannel=({channel})=>{p.channel=channel;channel.onmessage=e=>p.controls.push(JSON.parse(e.data));};
  const session={threadId:'owned',subscribe(fn){notify=fn;return()=>{notify=undefined;};},async close(){p.closed++;clearInterval(p.poll);osc.stop();dest.stream.getTracks().forEach(t=>t.stop());remote.close();await context.close();},async request(method,params){
   p.calls.push(method);
   if(method==='thread/realtime/start'){
    await remote.setRemoteDescription({type:'offer',sdp:params.transport.sdp});remote.addTrack(dest.stream.getAudioTracks()[0],dest.stream);
    await remote.setLocalDescription(await remote.createAnswer());
    // Include host ICE candidates, as Codex's HTTP SDP answer does.
    if(remote.iceGatheringState!=='complete')await new Promise(resolve=>remote.addEventListener('icegatheringstatechange',()=>{if(remote.iceGatheringState==='complete')resolve();}));
    notify({method:'thread/realtime/sdp',params:{threadId:'owned',sdp:remote.localDescription.sdp}});
   }return{};
  }};
  p.notify=(message)=>notify(message);
  const provider=createCodexVoiceProvider({connect:async()=>session});
  p.abort=new AbortController();
  p.connection=await provider.open({id:'test',signal:p.abort.signal,emit(e){p.events.push(e);}});
  p.send=(type,extra={})=>p.channel.send(JSON.stringify({type,...extra}));
  p.input=setInterval(()=>p.connection.input(Array.from({length:960},(_,i)=>Math.sin(i*2*Math.PI*660/48000)*.2)),20);
 });
 await page.waitForFunction(()=>probe.channel?.readyState==='open' && probe.inputLevel>.01,undefined,{timeout:8000});
 await page.evaluate(()=>{
  probe.send('response.created');probe.send('output_audio_buffer.started',{response_id:'r1'});
  probe.notify({method:'thread/realtime/item/started',params:{threadId:'owned',item:{id:'session',type:'realtimeSessionStarted'}}});
  probe.notify({method:'thread/realtime/transcript/done',params:{threadId:'owned',role:'assistant',text:'legacy duplicate'}});
  probe.notify({method:'thread/realtime/item/completed',params:{threadId:'owned',item:{id:'t1',type:'transcriptSegment',role:'assistant',text:'loopback fixture'}}});
 });
 await page.waitForFunction(()=>probe.events.filter(e=>e.type==='audio'&&e.responseId==='r1').length>=3);
 assert.equal(await page.evaluate(()=>probe.events.filter(e=>e.type==='audio').every(e=>e.samples.length===960&&e.samples.every(Number.isFinite))),true);
 assert.equal(await page.evaluate(()=>probe.events.some(e=>e.type==='audio'&&e.samples.some(v=>Math.abs(v)>.01))),true);
 assert.deepEqual(await page.evaluate(()=>probe.events.filter(e=>e.type==='transcript').map(e=>e.text)),['loopback fixture']);
 await page.evaluate(()=>probe.connection.interrupt('r1'));
 await page.waitForFunction(()=>probe.controls.some(e=>e.type==='response.cancel')&&probe.controls.some(e=>e.type==='output_audio_buffer.clear'));
 assert.equal(await page.evaluate(()=>probe.calls.includes('voice/interrupt')),true);
 await page.evaluate(()=>{probe.baseline=probe.events.filter(e=>e.type==='audio').length;probe.channel.send(JSON.stringify({type:'response.done'}));});
 // New response gives an observable render barrier; old generation is gated.
 await page.evaluate(()=>probe.send('output_audio_buffer.started',{response_id:'r2'}));
 await page.waitForFunction(()=>probe.events.some(e=>e.type==='audio'&&e.responseId==='r2'));
 assert.equal(await page.evaluate(()=>probe.events.filter(e=>e.type==='audio').slice(probe.baseline).every(e=>e.responseId==='r2')),true);
 await page.evaluate(async()=>{clearInterval(probe.input);await probe.connection.close();await probe.connection.close();});
 await page.waitForFunction(()=>probe.contexts.every(c=>c.state==='closed'));
 assert.equal(await page.evaluate(()=>probe.closed),1);
 assert.equal(await page.evaluate(()=>probe.calls.at(-1)),'thread/realtime/stop');
 assert.deepEqual(errors,[]);
});

test("Codex provider cancellation waits for a late connector and closes it before releasing",{timeout:15000},async(t)=>{
 const page=await browser.newPage();t.after(()=>page.close());await page.goto(host.url);
 const result=await page.evaluate(async()=>{
  const {createCodexVoiceProvider}=await import('/dist/codex-voice/index.js');
  let release,closed=0,settled=false;
  const abort=new AbortController();
  const provider=createCodexVoiceProvider({connect:()=>new Promise(r=>{release=r;})});
  const result=provider.open({id:'late',signal:abort.signal,emit(){}}).then(()=>{settled=true;},()=>{settled=true;});
  abort.abort();await new Promise(r=>setTimeout(r,0));const early=settled;
  release({threadId:'late',async close(){closed++;},async request(){},subscribe(){return()=>{};}});
  await result;return{early,closed};
 });
 assert.deepEqual(result,{early:false,closed:1});
});

test("frameless v3 plays continuous RTP without response events and rotates voice on the same thread for interruption",{timeout:25000},async(t)=>{
 const page=await browser.newPage();t.after(()=>page.close());const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(host.url);
 await page.evaluate(async()=>{
  const {createCodexVoiceProvider}=await import('/dist/codex-voice/index.js');
  const p=window.duplex={events:[],calls:[],controls:[],contexts:[],peers:[],closed:0,round:0};let notify,active;
  const stop=async()=>{if(!active)return;const current=active;active=undefined;current.peer.close();current.osc.stop();current.dest.stream.getTracks().forEach(t=>t.stop());await current.context.close();};
  const session={threadId:'same-thread',subscribe(fn){notify=fn;return()=>{notify=undefined;};},async close(){p.closed++;await stop();},async request(method,params){
   p.calls.push({method,threadId:params.threadId});
   if(method==='thread/realtime/stop')await stop();
   if(method==='thread/realtime/start'){
    p.round++;const peer=new RTCPeerConnection(),context=new AudioContext({sampleRate:48000});p.peers.push(peer);p.contexts.push(context);
    const osc=context.createOscillator(),gain=context.createGain(),dest=context.createMediaStreamDestination();gain.gain.value=.1;osc.connect(gain).connect(dest);osc.start();active={peer,context,osc,dest};
    peer.ondatachannel=({channel})=>{p.send=(event)=>channel.send(JSON.stringify(event));channel.onopen=()=>channel.send(JSON.stringify({type:'session.started'}));channel.onmessage=e=>p.controls.push(JSON.parse(e.data));};
    await peer.setRemoteDescription({type:'offer',sdp:params.transport.sdp});peer.addTrack(dest.stream.getAudioTracks()[0],dest.stream);await context.resume();await peer.setLocalDescription(await peer.createAnswer());
    if(peer.iceGatheringState!=='complete')await new Promise(resolve=>peer.addEventListener('icegatheringstatechange',()=>{if(peer.iceGatheringState==='complete')resolve();}));
    notify({method:'thread/realtime/sdp',params:{threadId:'same-thread',sdp:peer.localDescription.sdp}});
   }return{};
  }};
  const provider=createCodexVoiceProvider({connect:async()=>session});p.abort=new AbortController();
  p.connection=await provider.open({id:'duplex',signal:p.abort.signal,emit:e=>p.events.push(e)});
 });
 await page.waitForFunction(()=>duplex.events.filter(e=>e.type==='audio').length>=3);
 await page.evaluate(()=>{duplex.send({type:'input_transcript.added',item:{text:'fixture '}});duplex.send({type:'input_transcript.added',item:{text:'speech'}});});
 await page.waitForFunction(()=>duplex.events.some(e=>e.type==='transcript'&&e.text==='fixture speech'));
 const first=await page.evaluate(()=>duplex.events.find(e=>e.type==='audio').responseId);
 await page.evaluate(()=>duplex.connection.interrupt());
 await page.waitForFunction(()=>duplex.events.some(e=>e.type==='audio'&&e.responseId!==duplex.events.find(e=>e.type==='audio').responseId));
 assert.equal(await page.evaluate(()=>duplex.round),2);
 assert.equal(await page.evaluate(()=>duplex.calls.filter(c=>c.method==='thread/realtime/start').every(c=>c.threadId==='same-thread')),true);
 assert.equal(await page.evaluate(()=>duplex.calls.some(c=>c.method==='voice/interrupt')),true);
 assert.deepEqual(await page.evaluate(()=>duplex.controls),[]);
 assert.equal(await page.evaluate(()=>duplex.peers[0].connectionState),'closed');
 assert.ok(await page.evaluate(first=>duplex.events.some(e=>e.type==='audio'&&e.responseId!==first),first));
 await page.evaluate(()=>duplex.connection.close());
 assert.equal(await page.evaluate(()=>duplex.closed),1);assert.equal(await page.evaluate(()=>duplex.contexts.every(c=>c.state==='closed')),true);
 assert.deepEqual(errors,[]);
});
