// Provider-selection UI and real browser resource ownership; AI replies are fixtures.
import assert from "node:assert/strict";
import { before,after,test } from "node:test";
import { chromium } from "playwright";
import { createAiHost } from "../../scripts/ai-host.mjs";
import { providerFixtures } from "../fixtures/ai-backends.mjs";
let browser,host,fixtures;
before(async()=>{fixtures=providerFixtures();host=await createAiHost({port:0,...fixtures});browser=await chromium.launch({channel:process.env.HUDDLE_BROWSER_CHANNEL??'chrome',headless:true,
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
 await page.reload();await page.waitForFunction(()=>!document.getElementById('start').disabled);assert.equal(await page.locator('#provider').inputValue(),'claude');
 await page.locator('#provider').selectOption('codex');await page.waitForFunction(()=>document.getElementById('start').textContent==='Codex와 통화 시작'&&!document.getElementById('start').disabled);
});
test('a late readiness response from the previous AI cannot overwrite the new selection',{timeout:15000},async t=>{
 const page=await pageFor(t);let release;const pending=new Promise(r=>{release=r;});
 await page.route('**/api/providers/codex',async route=>{await pending;await route.fulfill({contentType:'application/json',body:JSON.stringify({ready:false,error:'old Codex result'})}).catch(()=>{});});
 await page.goto(host.url);await page.locator('#provider').selectOption('claude');
 await page.waitForFunction(()=>document.getElementById('setup').textContent.includes('Claude test provider'));
 release();await page.waitForFunction(()=>!document.getElementById('start').disabled);
 assert.equal(await page.locator('#provider').inputValue(),'claude');assert.equal((await page.locator('#setup').textContent()).includes('old Codex result'),false);
});
