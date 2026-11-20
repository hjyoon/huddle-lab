// Provider-selection UI and real browser resource ownership; AI replies are fixtures.
import assert from "node:assert/strict";
import { before,after,test } from "node:test";
import { chromium } from "playwright";
import { createAiHost } from "../../scripts/ai-host.mjs";
import { providerFixtures } from "../fixtures/ai-backends.mjs";
let browser,host,fixtures;
before(async()=>{fixtures=providerFixtures();host=await createAiHost({port:0,...fixtures,openclawRemote:{backend:fixtures.openclaw.backend}});browser=await chromium.launch({channel:process.env.HUDDLE_BROWSER_CHANNEL??'chrome',headless:true,
 args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--autoplay-policy=no-user-gesture-required','--mute-audio']});});
after(async()=>{await browser?.close();await host?.close();});
async function pageFor(t){const page=await browser.newPage();t.after(()=>page.close());const errors=[];page.on('pageerror',e=>errors.push(e.message));t.after(()=>assert.deepEqual(errors,[]));return page;}
test('user selects the AI, only that provider starts, and selection unlocks after hangup',{timeout:30000},async t=>{
 const page=await pageFor(t);await page.addInitScript(()=>{window.tracks=[];const acquire=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);navigator.mediaDevices.getUserMedia=async(...a)=>{const s=await acquire(...a);tracks.push(...s.getTracks());return s;};});
 await page.goto(host.url);await page.waitForFunction(()=>!document.getElementById('start').disabled);
 assert.equal(await page.locator('#provider').inputValue(),'codex');await page.locator('#start').click();
 await page.waitForFunction(()=>document.getElementById('status').textContent==='연결 실패');assert.match(await page.locator('#error').textContent(),/Codex fixture selected/);assert.equal(fixtures.calls.codexStarts,1);
 await page.locator('#provider').selectOption('claude');await page.waitForFunction(()=>!document.getElementById('start').disabled&&document.getElementById('start').textContent==='Claude와 통화 시작');
 assert.equal(await page.locator('#error').textContent(),'');await page.locator('#start').click();await page.waitForFunction(()=>document.getElementById('status').textContent==='통화 중');
 assert.equal(await page.locator('#provider').isDisabled(),true);assert.equal(fixtures.calls.codexStarts,1);
 await page.locator('#stop').click();await page.waitForFunction(()=>document.getElementById('status').textContent==='대기 중');assert.equal(await page.locator('#provider').isEnabled(),true);
 assert.equal(await page.evaluate(()=>tracks.every(track=>track.readyState==='ended')),true);
 await page.locator('#provider').selectOption('openclaw');await page.waitForFunction(()=>!document.getElementById('start').disabled&&document.getElementById('start').textContent==='OpenClaw와 통화 시작');
 assert.match(await page.locator('#description').textContent(),/OpenClaw/);await page.locator('#start').click();await page.waitForFunction(()=>document.getElementById('status').textContent==='통화 중');
 assert.equal(await page.locator('#provider').isDisabled(),true);await page.locator('#stop').click();await page.waitForFunction(()=>document.getElementById('status').textContent==='대기 중');
 await page.reload();await page.waitForFunction(()=>!document.getElementById('start').disabled);assert.equal(await page.locator('#provider').inputValue(),'openclaw');
 await page.locator('#provider').selectOption('codex');await page.waitForFunction(()=>document.getElementById('start').textContent==='Codex와 통화 시작'&&!document.getElementById('start').disabled);
});
test('remote credentials stay masked, can be shown after reload, and can be removed',{timeout:20000},async t=>{
 const page=await pageFor(t);await page.goto(host.url);await page.locator('#provider').selectOption('openclaw');await page.locator('#openclaw-mode').selectOption('remote');
 await page.locator('#remote-settings').waitFor({state:'visible'});
 const secret=page.locator('#remote-secret'),eye=page.locator('#remote-secret-toggle'),value='fixture-secret';
 await page.locator('#remote-url').fill('wss://gateway.example/');await page.locator('#remote-auth-type').selectOption('password');await secret.fill(value);await page.locator('#remote-agent').fill('voice');
 await eye.click();assert.equal(await secret.getAttribute('type'),'text');assert.equal(await secret.inputValue(),value);
 await eye.click();assert.equal(await secret.getAttribute('type'),'password');
 assert.equal(await page.locator('#start').isDisabled(),true);
 await page.locator('#remote-apply').click();await page.waitForFunction(()=>!document.getElementById('start').disabled);
 assert.equal(await secret.inputValue(),value);assert.equal(await secret.getAttribute('type'),'password');
 assert.equal(await page.evaluate(value=>JSON.stringify({...localStorage,...sessionStorage}).includes(value),value),false);
 const config=await(await page.request.get(host.url+'/api/providers/openclaw/remote')).json();assert.equal(config.url,'wss://gateway.example/');assert.equal(config.agent,'voice');assert.equal(config.token,undefined);
 await page.locator('#start').click();await page.waitForFunction(()=>document.getElementById('status').textContent==='통화 중');
 for(const selector of ['#provider','#openclaw-mode','#remote-url','#remote-secret','#remote-agent','#remote-apply','#remote-recheck','#remote-delete'])assert.equal(await page.locator(selector).isDisabled(),true);
 await page.locator('#stop').click();await page.waitForFunction(()=>document.getElementById('status').textContent==='대기 중');
 let reveals=0;page.on('request',request=>{if(request.url().endsWith('/remote/reveal'))reveals++;});
 await page.reload();await page.waitForFunction(()=>!document.getElementById('start').disabled);
 assert.equal(await page.locator('#openclaw-mode').inputValue(),'remote');assert.equal(await page.locator('#remote-url').inputValue(),'wss://gateway.example/');
 assert.equal(await page.locator('#remote-auth-type').inputValue(),'password');assert.equal(reveals,0);
 assert.equal(await secret.getAttribute('type'),'password');assert.match(await secret.getAttribute('placeholder'),/•/);
 await eye.click();await page.waitForFunction(()=>document.getElementById('remote-secret').type==='text');
 assert.equal(reveals,1);assert.equal(await secret.inputValue(),value);
 await eye.click();assert.equal(await secret.getAttribute('type'),'password');assert.equal(await secret.inputValue(),value);
 await page.locator('#remote-recheck').click();await page.waitForFunction(()=>!document.getElementById('start').disabled);
 assert.equal(await secret.inputValue(),value);
 await page.locator('#remote-apply').click();await page.waitForFunction(()=>!document.getElementById('start').disabled);
 assert.equal(await secret.inputValue(),value);
 await page.locator('#remote-url').fill('wss://another.example/');assert.equal(await page.locator('#start').isDisabled(),true);
 assert.equal(await secret.inputValue(),'');assert.equal(await eye.isDisabled(),true);
 await page.locator('#remote-recheck').click();await page.waitForFunction(()=>!document.getElementById('start').disabled);
 assert.equal(await page.locator('#remote-url').inputValue(),'wss://gateway.example/');
 await page.locator('#remote-delete').click();await page.locator('#remote-delete').waitFor({state:'hidden'});
 assert.equal(await page.locator('#start').isDisabled(),true);
 assert.equal(await secret.inputValue(),'');assert.equal(await eye.isDisabled(),true);
 assert.equal((await(await page.request.get(host.url+'/api/providers/openclaw/remote')).json()).hasCredentials,false);
 await page.locator('#openclaw-mode').selectOption('local');await page.waitForFunction(()=>!document.getElementById('start').disabled);assert.equal(await page.locator('#remote-settings').isHidden(),true);
});
test('a late readiness response from the previous AI cannot overwrite the new selection',{timeout:15000},async t=>{
 const page=await pageFor(t);let release;const pending=new Promise(r=>{release=r;});
 await page.route('**/api/providers/codex',async route=>{await pending;await route.fulfill({contentType:'application/json',body:JSON.stringify({ready:false,error:'old Codex result'})}).catch(()=>{});});
 await page.goto(host.url);await page.locator('#provider').selectOption('claude');
 await page.waitForFunction(()=>document.getElementById('setup').textContent.includes('Claude test provider'));
 release();await page.waitForFunction(()=>!document.getElementById('start').disabled);
 assert.equal(await page.locator('#provider').inputValue(),'claude');assert.equal((await page.locator('#setup').textContent()).includes('old Codex result'),false);
});
test('the mobile call surface shows the live timer, accessible controls and the transcript ahead of settings',{timeout:20000},async t=>{
 const page=await pageFor(t);
 await page.setViewportSize({width:390,height:844});
 await page.goto(host.url);
 await page.locator('#provider').selectOption('claude');
 await page.locator('#start').click();
 await page.waitForFunction(()=>document.getElementById('status').textContent==='통화 중');
 assert.ok(await page.locator('#start').isHidden());
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),390);
 const position=async id=>(await page.locator(id).boundingBox()).y;
 assert.ok(await position('#stop')<844);
 assert.ok(await position('#conversation-title')<await position('#settings-title'));
 const mute=page.getByRole('button',{name:'마이크 음소거',exact:true});
 await mute.click();
 assert.equal(await page.locator('#mute').getAttribute('aria-pressed'),'true');
 await page.waitForFunction(()=>document.getElementById('call-duration').textContent!=='00:00');
 await page.locator('#stop').click();
 await page.waitForFunction(()=>document.getElementById('status').textContent==='대기 중');
 assert.equal(await page.locator('#call-duration').textContent(),'00:00');
 assert.ok(await page.locator('#call-actions').isHidden());
 assert.ok(await page.locator('#start').isVisible());
});

test('the OpenClaw route waits for a tap and only shows elapsed time during a call',{timeout:20000},async t=>{
 const direct=await createAiHost({port:0,...providerFixtures(),openclawRemote:{
  remote:{url:'wss://gateway.example/',token:'fixture-token'},backend:fixtures.openclaw.backend,
 }});
 t.after(()=>direct.close());
 const page=await pageFor(t);
 await page.setViewportSize({width:390,height:844});
 await page.goto(direct.url);
 await page.waitForFunction(()=>!document.getElementById('start').disabled);
 assert.equal(await page.locator('#status').textContent(),'대기 중');
 assert.equal(await page.locator('#provider').inputValue(),'codex');
 await page.locator('#provider').selectOption('openclaw');
 await page.getByLabel('통화 표시 이름').fill('도우미');
 await page.addInitScript(()=>{
  if(location.pathname!=='/openclaw')return;
  const capture=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia=async(...args)=>{
   await new Promise(resolve=>{window.continueCapture=resolve;});
   return capture(...args);
  };
 });
 await page.goto(direct.url+'/openclaw');
 const dial=page.getByRole('button',{name:'통화',exact:true});
 const duration=page.locator('#call-duration');
 await page.waitForFunction(()=>!document.getElementById('start').disabled);
 assert.equal(await page.locator('#status').textContent(),'대기 중');
 assert.equal(await page.evaluate(()=>window.continueCapture===undefined),true);
 assert.ok(await duration.isHidden());
 await dial.click();
 await page.waitForFunction(()=>typeof window.continueCapture==='function');
 assert.equal(await page.locator('#status').textContent(),'연결 중');
 assert.ok(await duration.isHidden());
 await page.evaluate(()=>window.continueCapture());
 await page.waitForFunction(()=>document.getElementById('status').textContent==='통화 중');
 assert.ok(await duration.isVisible());
 await page.waitForFunction(()=>document.getElementById('call-duration').textContent!=='00:00');
 assert.equal(await page.locator('#call-title').textContent(),'도우미');
 assert.ok(await page.locator('#settings').isHidden());
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),390);
 await page.getByRole('button',{name:'오디오',exact:true}).click();
 assert.equal(await page.locator('#speaker').getAttribute('aria-pressed'),'true');
 await page.getByRole('button',{name:'대화 기록',exact:true}).click();
 assert.ok(await page.locator('#conversation').isVisible());
 const hangup=await page.locator('#stop .control-icon').boundingBox();
 await page.locator('#stop').click();
 await page.waitForFunction(()=>document.getElementById('status').textContent==='대기 중');
 assert.ok(await duration.isHidden());
 assert.ok(await dial.isVisible());
 const icon=dial.locator('.control-icon');
 const size=await icon.boundingBox();
 assert.equal(size.width,hangup.width);
 assert.equal(size.height,hangup.height);
 await page.mouse.move(0,0);
 assert.equal(await icon.evaluate(node=>getComputedStyle(node).backgroundColor),'rgb(155, 222, 116)');
});

test('OpenClaw exposes an audio resume action if autoplay requires a tap',{timeout:20000},async t=>{
 const direct=await createAiHost({port:0,...providerFixtures(),openclawRemote:{
  remote:{url:'wss://gateway.example/',token:'fixture-token'},backend:fixtures.openclaw.backend,
 }});
 t.after(()=>direct.close());
 const page=await pageFor(t);
 await page.addInitScript(()=>{
  const resume=AudioContext.prototype.resume;
  const state=Object.getOwnPropertyDescriptor(BaseAudioContext.prototype,'state').get;
  let first=true,pending;
  Object.defineProperty(AudioContext.prototype,'state',{get(){
   return pending?.context===this?'suspended':state.call(this);
  }});
  AudioContext.prototype.resume=function(){
   if(first){
    first=false;
    return new Promise((resolve,reject)=>{pending={context:this,resolve,reject};});
   }
   const resumed=resume.call(this);
   if(pending?.context===this){
    const {resolve,reject}=pending;
    pending=undefined;
    resumed.then(resolve,reject);
   }
   return resumed;
  };
 });
 await page.goto(direct.url+'/openclaw/');
 await page.getByRole('button',{name:'통화',exact:true}).click();
 const resume=page.getByRole('button',{name:'탭해서 오디오 시작'});
 await resume.click();
 await page.waitForFunction(()=>document.getElementById('status').textContent==='통화 중');
 assert.ok(await resume.isHidden());
 await page.locator('#stop').click();
 await page.waitForFunction(()=>document.getElementById('status').textContent==='대기 중');
});
