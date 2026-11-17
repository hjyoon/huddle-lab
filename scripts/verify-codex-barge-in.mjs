// Opt-in LIVE test: uses the installed Codex login and remote voice service.
// Input is prerecorded synthetic speech. No physical microphone is acquired.
import { chromium } from "playwright";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCodexHost } from "./codex-host.mjs";

async function main() {
  const directory = resolve(process.argv[2] ?? ".huddle-runtime/barge-in");
  const trials = Number(process.argv[3] ?? 2);
  const mode = process.argv[4] ?? "barge-in";
  if (!["barge-in", "control"].includes(mode)) throw new Error("Mode must be barge-in or control.");
  const prefix = mode === "control" ? "control" : "trial";
  if (!Number.isInteger(trials) || trials < 1 || trials > 5) throw new Error("Choose 1–5 live trials.");
  const prompt = await readFile(join(directory, "prompt.wav"));
  const interruption = await readFile(join(directory, "interrupt.wav"));
  await mkdir(directory, { recursive: true });
  const host = await createCodexHost({ port: 0 });
  let browser;
  const summaries = [];
  const meterCode = `
        class Meter extends AudioWorkletProcessor {
          offset=0; peak=0; sum=0;
          process(inputs) {
            for(const sample of inputs[0]?.[0] ?? []) {
              this.peak=Math.max(this.peak,Math.abs(sample));this.sum+=sample*sample;
              if(++this.offset===960) {
                this.port.postMessage({peak:this.peak,rms:Math.sqrt(this.sum/960)});
                this.offset=0;this.peak=0;this.sum=0;
              }
            }
            return true;
          }
        }
        registerProcessor('barge-meter',Meter);
      `;
  try {
    browser = await chromium.launch({
      channel: process.env.HUDDLE_BROWSER_CHANNEL ?? "chrome", headless: true,
      args: ["--autoplay-policy=no-user-gesture-required", "--mute-audio"],
    });
    const status = await host.inspect();
    if (!status.ready) throw new Error(status.error ?? "Codex is not signed in.");
    for (let trial = 1; trial <= trials; trial++) {
      console.log(`Live trial ${trial}/${trials}: ${status.version}`);
      const page = await browser.newPage();
      const pageErrors = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      await page.route("**/barge-prompt.wav", (route) => route.fulfill({ contentType: "audio/wav", body: prompt }));
      await page.route("**/barge-interrupt.wav", (route) => route.fulfill({ contentType: "audio/wav", body: interruption }));
      try {
        // An idle diagnostic page provides the same production modules/origin.
        await page.goto(host.url + "/examples/browser/index.html");
        await page.evaluate(async (meterCode) => {
          const [{ createAgentHuddle }, { openWebAudio }, { createCodexVoiceProvider, createCodexLocalConnector }] = await Promise.all([
            import("/dist/agent-voice/index.js"), import("/dist/web-audio/index.js"), import("/dist/codex-voice/index.js"),
          ]);
          const p = window.bargeProbe = { epoch: performance.now(), frames: [], events: [], requests: [], states: [],
            clears: [], contexts: [], peers: [], stage: "silence", markers: {}, sources: [] };
          const now = () => performance.now() - p.epoch;
          const frame = (stream, samples, extra = {}) => {
            let peak=0,sum=0;for(const n of samples){peak=Math.max(peak,Math.abs(n));sum+=n*n;}
            p.frames.push({ t: now(), stream, peak, rms: Math.sqrt(sum/samples.length), ...extra });
          };
          const Context = AudioContext;
          window.AudioContext = class extends Context { constructor(...args) { super(...args); p.contexts.push(this); } };
          const Worklet = AudioWorkletNode;
          window.AudioWorkletNode = class extends Worklet {
            constructor(...args) {
              super(...args);
              if (args[1] === "codex-huddle-capture") {
                this.port.addEventListener("message", ({ data }) => frame("remote", data.samples));this.port.start();
              }
            }
          };
          const Peer = RTCPeerConnection;
          window.RTCPeerConnection = class extends Peer {
            constructor(...args) { super(...args); p.peers.push(this); }
            createDataChannel(...args) {
              const channel = super.createDataChannel(...args);
              channel.addEventListener("message", ({ data }) => {
                try {
                  const item=JSON.parse(data), turn=item.turn;
                  p.events.push({ t:now(), type:item.type, text:item.item?.text ?? item.delta,
                    turn: turn ? Object.fromEntries(Object.entries(turn).filter(([key])=>["id","role","transcript","status","reason","interrupted"].includes(key))) : undefined,
                    keys:Object.keys(item), turnKeys:turn ? Object.keys(turn) : undefined, error:item.error, reason:item.reason });
                } catch { /* Not a protocol event. */ }
              });return channel;
            }
          };
          const send = WebSocket.prototype.send;
          WebSocket.prototype.send = function(data) {
            try { const message=JSON.parse(data);if(message.method)p.requests.push({t:now(),method:message.method}); } catch {}
            return send.call(this,data);
          };
          const connect = AudioNode.prototype.connect;
          AudioNode.prototype.connect = function(target, ...args) {
            if (this instanceof GainNode && target instanceof AudioDestinationNode && !p.speaker) p.speaker=this;
            return connect.call(this,target,...args);
          };
          const mic = new AudioContext({ sampleRate:48000 });
          const destination = mic.createMediaStreamDestination();await mic.resume();
          navigator.mediaDevices.getUserMedia = async () => destination.stream;
          const load = async(path) => mic.decodeAudioData(await (await fetch(path)).arrayBuffer());
          const [first, second] = await Promise.all([load("/barge-prompt.wav"), load("/barge-interrupt.wav")]);
          p.play = async(which) => {
            p.stage=which;p.markers[`${which}Scheduled`]=now();
            const source=mic.createBufferSource();p.sources.push(source);source.buffer=which==="prompt"?first:second;
            source.connect(destination);source.start(mic.currentTime+.02);
            await new Promise(resolve=>{source.onended=resolve;});
            p.markers[`${which}Ended`]=now();p.stage="silence";
          };
          const provider = createCodexVoiceProvider({ connect:createCodexLocalConnector(`ws://${location.host}/codex`) });
          p.huddle = createAgentHuddle({
            provider: { id:provider.id,name:provider.name,open(context) {
              return provider.open({ ...context,emit(event) {
                if(event.type!=="audio")p.events.push({t:now(),provider:true,...event});
                context.emit(event);
              } });
            } },
            openAudio: async(send,ended,signal) => {
              const audio=await openWebAudio(samples=>{frame("microphone",samples,{stage:p.stage});send(samples);},ended,signal);
              return { ...audio, participants(peers) {
                if(!peers.some(peer=>peer.startsWith("agent:")))p.clears.push(now());audio.participants(peers);
              } };
            },
          });
          p.huddle.subscribe(()=>{const s=p.huddle.snapshot();p.states.push({t:now(),phase:s.phase,activity:s.activity,error:s.error});});
          await p.huddle.start();
          if(p.huddle.snapshot().phase!=="connected")throw new Error(p.huddle.snapshot().error ?? "Voice failed to connect");
          const meterUrl=URL.createObjectURL(new Blob([meterCode],{type:"text/javascript"}));
          try { await p.speaker.context.audioWorklet.addModule(meterUrl); } finally { URL.revokeObjectURL(meterUrl); }
          const meter=new AudioWorkletNode(p.speaker.context,"barge-meter");
          meter.port.onmessage=({data})=>p.frames.push({t:now(),stream:"speaker",...data});
          p.speaker.connect(meter);meter.connect(p.speaker.context.destination);
          p.cleanup = async()=>{
            await p.huddle.leave();destination.stream.getTracks().forEach(track=>track.stop());await mic.close();
            p.cleanupResult={phase:p.huddle.snapshot().phase,contextsClosed:p.contexts.every(c=>c.state==="closed"),
              peersClosed:p.peers.every(peer=>peer.connectionState==="closed"),tracksEnded:destination.stream.getTracks().every(track=>track.readyState==="ended")};
          };
        }, meterCode);
        await page.evaluate(() => bargeProbe.play("prompt"));
        await page.waitForFunction(() => bargeProbe.frames.filter(f=>f.stream==="speaker"&&f.rms>.003).length>=45,
          undefined,{ timeout:35000 });
        // Wait for actual speech after >=900 ms accumulated voiced audio, rather
        // than scheduling the second utterance at a guessed model latency.
        await page.waitForFunction(() => {
          const p=bargeProbe,latest=p.frames.findLast(f=>f.stream==="speaker"&&f.rms>.003);
          return latest && performance.now()-p.epoch-latest.t<80;
        },undefined,{timeout:5000});
        if (mode === "control") {
          console.log(`Control ${trial}: keeping the microphone silent while AI continues.`);
          await page.evaluate(()=>{bargeProbe.markers.controlAnchor=performance.now()-bargeProbe.epoch;});
          await page.waitForFunction(()=>performance.now()-bargeProbe.epoch-bargeProbe.markers.controlAnchor>12000,
            undefined,{timeout:18000});
        } else {
          console.log(`Trial ${trial}: AI is speaking; injecting interruption (no button/RPC interrupt).`);
          await page.evaluate(() => bargeProbe.play("interrupt"));
          // Keep the real duplex session alive to observe silence and the new reply.
          await page.waitForFunction(() => {
            const p=bargeProbe;return performance.now()-p.epoch-p.markers.interruptEnded>8500 || p.huddle.snapshot().phase==="error";
          },undefined,{timeout:15000});
        }
        const trace = await page.evaluate(() => {
          const p=bargeProbe;return {markers:p.markers,frames:p.frames,events:p.events,requests:p.requests,states:p.states,clears:p.clears,
            transcripts:p.huddle.snapshot().transcripts,phase:p.huddle.snapshot().phase,error:p.huddle.snapshot().error,peerCount:p.peers.length,
            outputLatency:p.speaker.context.outputLatency,baseLatency:p.speaker.context.baseLatency};
        });
        await page.evaluate(() => bargeProbe.cleanup());
        trace.cleanup = await page.evaluate(() => bargeProbe.cleanupResult);
        trace.pageErrors=pageErrors;
        await writeFile(join(directory,`${prefix}-${trial}.json`),JSON.stringify(trace,null,2)+"\n");
        const summary=analyzeBargeInTrace(trace, mode);summaries.push({trial,...summary});console.log(JSON.stringify(summaries.at(-1)));
      } catch (error) {
        const failure = await page.evaluate(() => {
          const p=window.bargeProbe;
          return p ? {markers:p.markers,frames:p.frames,events:p.events,requests:p.requests,states:p.states,clears:p.clears,
            transcripts:p.huddle?.snapshot().transcripts,phase:p.huddle?.snapshot().phase,error:p.huddle?.snapshot().error,peerCount:p.peers.length} : {};
        }).catch(()=>({}));
        await writeFile(join(directory,`${prefix}-${trial}-failure.json`),JSON.stringify({...failure,failure:error.message,pageErrors},null,2)+"\n");
        throw error;
      } finally { await page.close(); }
    }
    await writeFile(join(directory, mode === "control" ? "control-summary.json" : "summary.json"),JSON.stringify({ timestamp:new Date().toISOString(),version:status.version,
      mode,environment:"live Codex WebRTC, synthetic microphone, no manual interruption",summaries },null,2)+"\n");
    console.log(`Evidence: ${directory}/${mode === "control" ? "control-summary.json" : "summary.json"}`);
    if (mode === "barge-in" && summaries.some(row=>!row.automaticBargeInObserved)) process.exitCode=1;
  } finally { await browser?.close();await host.close(); }

}

export function analyzeBargeInTrace(trace, mode = "barge-in") {
  if (mode === "control") return {
    control:true,assistantTranscript:trace.events.filter(e=>["output_transcript.added","session.output_transcript.delta"].includes(e.type)).map(e=>e.text??"").join(""),
    voiceFramesAfterAnchor:trace.frames.filter(f=>f.stream==="speaker"&&f.t>trace.markers.controlAnchor+4000&&f.rms>.003).length,
    peerCount:trace.peerCount,phase:trace.phase,error:trace.error??null,cleanup:trace.cleanup,pageErrors:trace.pageErrors,
  };
  const threshold=.003;
  const input=trace.frames.filter(f=>f.stream==="microphone"&&f.stage==="interrupt"&&f.rms>threshold);
  const onset=input[0]?.t, end=input.at(-1)?.t;
  if(onset===undefined||end===undefined)throw new Error("The interruption never reached microphone capture.");
  const gap=(stream)=>{
    const frames=trace.frames.filter(f=>f.stream===stream&&f.t>=onset&&f.t<=end+1000);
    let start;
    for(const f of frames){
      if(f.rms<=threshold){start??=f.t;if(f.t-start>=500)return{startMs:Math.round(start-onset),durationMs:Math.round(f.t-start)};}
      else start=undefined;
    }return null;
  };
  const firstInputEvent=trace.events.find(e=>e.t>=onset&&["input_transcript.added","session.input_transcript.delta"].includes(e.type));
  const oldTurnEnd=trace.events.find(e=>e.t>=onset&&e.type==="turn.done"&&e.turn?.role==="assistant");
  const overlap=oldTurnEnd ? trace.frames.filter(f=>f.stream==="speaker"&&f.rms>threshold&&f.t>=onset&&f.t<=oldTurnEnd.t&&input.some(m=>Math.abs(m.t-f.t)<=25)).length*20 : 0;
  const firstLocalInterrupt=trace.events.find(e=>e.t>=onset&&e.type==="response-interrupted");
  const manualRequests=trace.requests.filter(r=>r.method==="voice/interrupt").length;
  const starts=trace.requests.filter(r=>r.method==="thread/realtime/start").length;
  const text=trace.events.filter(e=>e.t>=onset&&["output_transcript.added","session.output_transcript.delta"].includes(e.type)).map(e=>e.text??"").join("");
  return {inputDurationMs:Math.round(end-onset),speakerActiveAtOnset:trace.frames.some(f=>f.stream==="speaker"&&f.rms>threshold&&f.t>=onset-150&&f.t<=onset),
    recognitionLatencyMs:firstInputEvent?Math.round(firstInputEvent.t-onset):null,
    previousAssistantTurnDoneLatencyMs:oldTurnEnd?Math.round(oldTurnEnd.t-onset):null,
    previousAssistantTranscript:oldTurnEnd?.turn?.transcript??null,
    oldAssistantSpeakerOverlapMsApprox:overlap,
    localInterruptLatencyMs:firstLocalInterrupt?Math.round(firstLocalInterrupt.t-onset):null,
    // The first silence can be an ordinary pause between numbers. It is NOT
    // an interruption-latency estimate; use it only with the full event trace.
    firstRemote500msSilence:gap("remote"),firstSpeaker500msSilence:gap("speaker"),
    assistantAfterOnset:text,changedReplyToBanana:/banana|바나나/i.test(text),peerCount:trace.peerCount,
    manualInterruptRequests:manualRequests,realtimeStarts:starts,
    automaticBargeInObserved:overlap>0&&!!firstInputEvent&&!!oldTurnEnd&&/banana|바나나/i.test(text)&&trace.peerCount===1&&manualRequests===0&&starts===1&&trace.phase==="connected"&&!trace.error,
    phase:trace.phase,error:trace.error??null,cleanup:trace.cleanup,pageErrors:trace.pageErrors};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
