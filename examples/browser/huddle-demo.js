import { createAgentHuddle } from "../../dist/agent-voice/index.js";
import { createWebAudioAdapter,openWebAudio } from "../../dist/web-audio/index.js";
import { createCodexVoiceProvider,createCodexLocalConnector } from "../../dist/codex-voice/index.js";
import { createClaudeVoiceProvider } from "../../dist/claude-voice/index.js";
import { createOpenClawVoiceProvider } from "../../dist/openclaw-voice/index.js";
import { createHermesVoiceProvider } from "../../dist/hermes-voice/index.js";
const element=id=>document.getElementById(id);
const names={codex:"Codex",claude:"Claude",openclaw:"OpenClaw",hermes:"Hermes"};
const vpnAccess=location.protocol==="https:";
const directCall=document.documentElement.classList.contains("direct-call");
const callNameKey="huddle-openclaw-call-name";
let huddle,off,ready=false,selected="codex",generation=0,checking,remoteMode="local",configuring=false;
let savedRemote=false,remoteStorageError=false;
let savedUrl,savedAuthType,usingSavedSecret=false,revealing,canLogin=false,loggingIn=false;
const emptyRows=[];
let displayedRows=emptyRows,connectedAt,clock;
let checked=false,resumeAudio,speakerMuted=false,clearOutput;
const secretInput=element("remote-secret");
const authTypeInput=element("remote-auth-type");
const remoteUrlInput=element("remote-url");
const callNameInput=element("openclaw-call-name");
try{callNameInput.value=(localStorage.getItem(callNameKey)??"").slice(0,callNameInput.maxLength);}catch{}
function canReuseSecret(){
 if(!usingSavedSecret||!savedRemote||authTypeInput.value!==savedAuthType)return false;
 try{return new URL(remoteUrlInput.value.trim()).href===savedUrl;}catch{return false;}
}
function maskSecret(){
 revealing?.abort();revealing=undefined;
 secretInput.type="password";
}
const idle=()=>!huddle||["idle","error"].includes(huddle.snapshot().phase);
function setText(id,text){
 const node=element(id);
 if(node.textContent!==text)node.textContent=text;
}
function animateCallBackdrop(){
 const colors=["#2d7668","#365aa0","#825294","#994e70","#886346","#3c7e9a","#4d7550","#5149a2"];
 const reducedMotion=matchMedia("(prefers-reduced-motion: reduce)");
 const layers=[...document.querySelectorAll(".call-glow")].map((node,index)=>({node,color:index,timer:undefined}));
 const randomBetween=(min,max)=>min+Math.random()*(max-min);
 function drift(layer){
  const seconds=randomBetween(5,11);
  const x=randomBetween(-38,38),y=randomBetween(-35,35),scale=randomBetween(.8,1.22);
  layer.color=(layer.color+Math.floor(randomBetween(1,colors.length)))%colors.length;
  Object.assign(layer.node.style,{
   transitionDuration:`${seconds}s`,
   transform:`translate(${x}%, ${y}%) scale(${scale})`,
   color:colors[layer.color],
   opacity:randomBetween(.42,.82),
  });
  layer.timer=setTimeout(()=>drift(layer),seconds*1000);
 }
 function syncMotion(){
  layers.forEach((layer,index)=>{
   clearTimeout(layer.timer);
   if(reducedMotion.matches){
    layer.node.removeAttribute("style");
    layer.color=index;
   }else if(!document.hidden){
    layer.timer=setTimeout(()=>drift(layer),120+index*310);
   }
  });
 }
 reducedMotion.addEventListener("change",syncMotion);
 document.addEventListener("visibilitychange",syncMotion);
 window.addEventListener("pageshow",syncMotion);
 window.addEventListener("pagehide",()=>layers.forEach(layer=>clearTimeout(layer.timer)));
 syncMotion();
}
const openDirectAudio=createWebAudioAdapter({
 onResumePending(resume){
  const timer=setTimeout(()=>{resumeAudio=resume;render();},300);
  return ()=>{
   clearTimeout(timer);
   if(resumeAudio===resume){resumeAudio=undefined;render();}
  };
 },
});
async function openDirectCallAudio(send,ended,signal){
 const audio=await openDirectAudio(send,ended,signal);
 const clear=()=>audio.participants([]);
 clearOutput=clear;
 return {
  ...audio,
  play(peer,samples){if(!speakerMuted)audio.play(peer,samples);},
  close(){if(clearOutput===clear)clearOutput=undefined;audio.close();},
 };
}
function renderTime(){
 const seconds=connectedAt===undefined?0:Math.floor((performance.now()-connectedAt)/1000);
 const hours=Math.floor(seconds/3600),minutes=Math.floor(seconds/60)%60;
 const parts=hours?[hours,minutes,seconds%60]:[minutes,seconds%60];
 setText("call-duration",parts.map(value=>String(value).padStart(2,"0")).join(":"));
 element("call-duration").dateTime=`PT${seconds}S`;
}
function updateClock(phase){
 if(phase==="connected"){
  if(clock===undefined){connectedAt=performance.now();renderTime();clock=setInterval(renderTime,250);}
  return;
 }
 clearInterval(clock);clock=undefined;
 if(phase!=="leaving"){connectedAt=undefined;renderTime();}
}
function renderTranscripts(rows){
 if(rows===displayedRows)return;
 const list=element("transcripts"),scroll=element("transcript-scroll");
 const atBottom=scroll.scrollHeight-scroll.clientHeight-scroll.scrollTop<32;
 const appendFrom=rows[0]===displayedRows[0]?displayedRows.length:0;
 if(!appendFrom)list.replaceChildren();
 for(const row of rows.slice(appendFrom)){
  const item=document.createElement("li");
  item.className="message";item.dataset.speaker=row.speaker;
  const speaker=document.createElement("span");speaker.className="message-speaker";
  speaker.textContent=row.speaker==="user"?"사용자":names[selected];
  const text=document.createElement("p");text.textContent=row.text;
  item.append(speaker,text);list.append(item);
 }
 element("empty-transcript").hidden=rows.length>0;
 if(atBottom)scroll.scrollTop=scroll.scrollHeight;
 displayedRows=rows;
}
const render=()=>{
 const state=huddle?.snapshot(),phase=state?.phase??"idle",connected=phase==="connected";
 const active=["connecting","connected","leaving"].includes(phase);
 const activity=state?.activity??"idle";
 const start=element("start"),call=element("call");
 const focusMoved=active&&document.activeElement===start;
 element("call-layout").dataset.phase=phase;
 call.dataset.phase=phase;call.dataset.activity=activity;call.dataset.muted=String(state?.muted??false);
 element("settings").dataset.ready=String(ready);
 updateClock(phase);
 setText("call-title",(directCall&&callNameInput.value.trim())||names[selected]);
 element("provider").disabled=!["idle","error"].includes(phase);
 element("openclaw-choice").hidden=selected!=="openclaw";
 element("openclaw-name-field").hidden=selected!=="openclaw";
 callNameInput.disabled=configuring||active;
 element("remote-settings").hidden=selected!=="openclaw"||remoteMode==="local";
 element("openclaw-mode").disabled=configuring||!["idle","error"].includes(phase);
 element("remote-fields").disabled=configuring||!["idle","error"].includes(phase);
 element("remote-recheck").hidden=!savedRemote;
 element("remote-delete").hidden=vpnAccess||!savedRemote&&!remoteStorageError;
 element("remote-apply").hidden=vpnAccess;
 element("remote-editor").hidden=vpnAccess;
 element("remote-vpn-note").hidden=!vpnAccess;
 const shown=secretInput.type==="text",reuseSecret=canReuseSecret();
 const toggle=element("remote-secret-toggle"),toggleLabel=shown?"인증 정보 숨기기":"인증 정보 보기";
 toggle.disabled=!!revealing||(!secretInput.value&&!reuseSecret&&!shown);
 toggle.setAttribute("aria-label",toggleLabel);toggle.setAttribute("aria-pressed",String(shown));toggle.title=toggleLabel;
 element("remote-secret-slash").toggleAttribute("hidden",!shown);
 secretInput.placeholder=reuseSecret?"••••••••••••":"";
 secretInput.required=!reuseSecret;
 if(configuring)element("provider").disabled=true;
 element("login-row").hidden=!canLogin||selected!=="claude";
 element("login").disabled=loggingIn||!["idle","error"].includes(phase);
 start.disabled=(!ready&&!(directCall&&checked))||active;start.hidden=active;
 element("resume-audio").hidden=!active||!resumeAudio;
 element("call-actions").hidden=!active;
 setText("start-label",directCall?"통화":`${names[selected]}와 통화 시작`);
 element("speaker").disabled=!connected;
 element("speaker").setAttribute("aria-pressed",String(speakerMuted));
 setText("speaker-label",speakerMuted?"오디오 켜기":"오디오");
 element("mute").disabled=!connected;element("interrupt").disabled=!connected||!["thinking","speaking"].includes(state.activity);
 element("stop").disabled=!["connecting","connected"].includes(phase);
 if(focusMoved&&!element("stop").disabled)element("stop").focus({preventScroll:true});
 setText("mute-label",state?.muted?"마이크 음소거 해제":"마이크 음소거");
 element("mute").setAttribute("aria-pressed",String(state?.muted??false));
 const connecting=resumeAudio?"오디오 시작 대기":directCall?"연결 중":`${names[selected]} 연결 중`;
 setText("status",({idle:directCall&&!checked?"Gateway 확인 중":"대기 중",connecting,connected:"통화 중",leaving:"종료 중",error:"연결 실패"})[phase]);
 setText("activity",state?.muted&&activity==="listening"?"마이크 음소거":({idle:"",listening:"듣는 중",thinking:"답변 준비 중",speaking:"말하는 중"})[activity]);
 const error=state?.error??(directCall&&checked&&!ready?element("setup").textContent:"");
 setText("error",directCall&&/permission denied|not allowed by the user agent/i.test(error)
  ?"브라우저의 마이크 권한을 확인한 뒤 다시 연결해 주세요.":error);
 renderTranscripts(state?.transcripts??emptyRows);
};
async function choose(id){
 if(!Object.hasOwn(names,id)||!idle()){element("provider").value=selected;return;}
 const gateway=id==="openclaw"&&remoteMode!=="local";
 const realtime=id==="codex"||(gateway&&remoteMode==="remote-realtime");
 maskSecret();
 const token=++generation;checking?.abort();checking=new AbortController();const signal=checking.signal;
 const previous=huddle;off?.();off=undefined;huddle=undefined;ready=false;checked=false;canLogin=false;selected=id;
 element("provider").value=id;
 if(!directCall)try{localStorage.setItem("huddle-ai",id);}catch{}
 element("setup").textContent=`${names[id]} 설치 및 연결 상태 확인 중…`;element("workspace").textContent="확인 중";
 element("description").textContent=id==="codex"?"Codex와 실시간 음성으로 대화합니다. 통화 음성은 Codex의 실시간 서비스로 전송합니다.":id==="claude"?"Claude Code와 음성으로 대화합니다. 음성 인식·합성은 Huddle 호스트에서 처리하고 인식한 대화 내용은 Claude 서비스로 전송합니다.":id==="hermes"?"Hermes Agent와 음성으로 대화합니다. 음성 인식·합성은 Huddle 호스트에서 처리하고 인식한 대화 내용은 Hermes API 서버로 전송합니다. Hermes는 자신의 도구를 사용할 수 있어 답변에 시간이 걸릴 수 있습니다.":"OpenClaw에 설정된 모델과 음성으로 대화합니다. 음성 인식·합성은 Huddle 호스트에서 처리하고 인식한 대화 내용은 설정된 모델 서비스로 전송합니다.";
 if(gateway)element("description").textContent=realtime
  ?"실시간 음성은 Codex 서비스에서 처리합니다. 질문과 작업 요청은 OpenClaw main으로 전달하고 답변을 통화에서 읽습니다."
  :"OpenClaw Gateway의 모델과 허용된 도구를 사용합니다. 음성 인식·합성은 Huddle 호스트에서 처리하고 인식한 대화 내용은 Gateway로 전송합니다.";
 element("hint").textContent=realtime?"AI가 말하는 중에도 다시 말할 수 있습니다. 응답 중단 버튼은 같은 대화의 음성 채널을 다시 연결합니다.":"말을 마친 뒤 잠시 쉬면 답변합니다. AI가 말할 때 다시 말하면 응답을 중단합니다. 한 번에 30초까지 말할 수 있습니다.";
 render();
 try{
  await previous?.dispose();if(token!==generation)return;
  if(gateway){
   const response=await fetch("/api/providers/openclaw/remote",{signal});if(!response.ok)throw new Error("원격 설정을 확인할 수 없습니다.");
   const config=await response.json();if(token!==generation)return;
   const keepValue=usingSavedSecret&&config.url===savedUrl&&config.authType===savedAuthType;
   if(config.url)remoteUrlInput.value=config.url;
   element("remote-agent").value=config.agent??"";
   savedRemote=!!config.hasCredentials;
   savedUrl=config.url;savedAuthType=config.authType;
   if(savedAuthType)authTypeInput.value=savedAuthType;
   if(!keepValue)secretInput.value="";
   usingSavedSecret=savedRemote;
   remoteStorageError=!!config.storageError;
   element("remote-config-status").textContent=config.storageError??(savedRemote?"저장된 인증으로 연결합니다.":"주소와 인증 정보를 입력하고 저장해 주세요.");
   render();
  }
  const result=await fetch(`/api/providers/${id}${id==="openclaw"?`?mode=${remoteMode}`:""}`,{signal});if(!result.ok)throw new Error("AI 상태를 확인할 수 없습니다.");
  const status=await result.json();if(token!==generation)return;
  element("workspace").textContent=status.workspace??"확인할 수 없음";
  ready=!!status.ready&&!status.busy;
  canLogin=!!status.needsLogin&&!!status.canLogin;
  const connection=realtime
    ? [status.voiceModel??"연결 준비됨",status.delegateAgent? `OpenClaw ${status.delegateAgent}`:undefined].filter(Boolean).join(" · ")
    : `로컬 음성 엔진 준비됨${status.modelName?` · ${status.modelName}`:""}`;
  element("setup").textContent=ready?`${status.version} · ${connection}`:(status.needsLogin?`${status.error} ${canLogin?"아래 버튼으로 브라우저에서 로그인하거나 ":"Huddle 호스트의 "}터미널에서 claude auth login을 실행해 주세요.`:status.error??(status.busy?"이미 통화 중입니다. 종료 후 다시 선택해 주세요.":"선택한 AI의 설치·로그인 상태를 확인해 주세요."));
  if(ready){
   const provider=id==="codex"||status.voiceTransport==="codex-realtime"
    ? createCodexVoiceProvider({connect:createCodexLocalConnector(status.wsUrl)})
    : id==="claude"?createClaudeVoiceProvider({url:status.wsUrl}):id==="hermes"?createHermesVoiceProvider({url:status.wsUrl}):createOpenClawVoiceProvider({url:status.wsUrl});
   const call=createAgentHuddle({provider,openAudio:directCall?openDirectCallAudio:openWebAudio});
   huddle=call;
   let previousState=call.snapshot();
   off=call.subscribe(()=>{
    const state=call.snapshot();
    if(state.phase===previousState.phase&&state.activity===previousState.activity&&state.muted===previousState.muted&&
       state.transcripts===previousState.transcripts&&state.error===previousState.error)return;
    previousState=state;render();
   });
  }
 }catch(error){if(token===generation&&!signal.aborted)element("setup").textContent=error.message;}
 if(token===generation){checked=true;render();}
}
element("provider").onchange=()=>{void choose(element("provider").value);};
callNameInput.addEventListener("input",()=>{
 try{localStorage.setItem(callNameKey,callNameInput.value.trim());}catch{}
});
element("openclaw-mode").onchange=()=>{
 if(!idle()||configuring){element("openclaw-mode").value=remoteMode;return;}
 remoteMode=element("openclaw-mode").value;
 try{localStorage.setItem("huddle-openclaw-mode",remoteMode);}catch{}
 void choose(selected);
};
async function updateRemoteSettings(settings){
 if(vpnAccess||!idle()||configuring)return;
 maskSecret();
 configuring=true;ready=false;const token=++generation;checking?.abort();checking=new AbortController();
 const previous=huddle;off?.();off=undefined;huddle=undefined;
 element("remote-config-status").textContent=settings?"설정 저장 중…":"인증 삭제 중…";render();
 try{
  await previous?.dispose();
  const request={method:settings?"POST":"DELETE",signal:checking.signal};
  if(settings){request.headers={"Content-Type":"application/json"};request.body=JSON.stringify(settings);}
  const response=await fetch("/api/providers/openclaw/remote",request);
  const result=await response.json();if(!response.ok)throw new Error(result.error??"원격 설정을 변경할 수 없습니다.");
  if(token!==generation)return;
  if(settings){
   savedUrl=new URL(settings.url).href;savedAuthType=authTypeInput.value;usingSavedSecret=true;
   try{localStorage.setItem("huddle-openclaw-url",settings.url);}catch{}
  }else{secretInput.value="";usingSavedSecret=false;}
  savedRemote=!!settings;remoteStorageError=false;
  configuring=false;await choose("openclaw");
 }catch(error){if(token===generation)element("remote-config-status").textContent=error.message;}
 finally{configuring=false;render();}
}
element("remote-settings").onsubmit=event=>{
 event.preventDefault();
 const settings={url:remoteUrlInput.value.trim(),agent:element("remote-agent").value.trim()};
 if(usingSavedSecret){
  if(!canReuseSecret())return;
  settings.reuseSaved=true;settings.authType=authTypeInput.value;
 }else settings[authTypeInput.value]=secretInput.value;
 void updateRemoteSettings(settings);
};
element("remote-recheck").onclick=()=>{
 if(!idle()||configuring||!savedRemote)return;
 void choose("openclaw");
};
element("remote-delete").onclick=()=>{void updateRemoteSettings();};
element("remote-secret-toggle").onclick=async()=>{
 if(!idle()||configuring||revealing)return;
 if(secretInput.type==="text"){maskSecret();render();return;}
 if(!canReuseSecret()){
  if(secretInput.value)secretInput.type="text";
  render();return;
 }
 const controller=new AbortController();revealing=controller;render();
 try{
  const response=await fetch("/api/providers/openclaw/remote/reveal",{
   method:"POST",headers:{"Content-Type":"application/json"},body:"{}",signal:controller.signal,
  });
  const result=await response.json();
  if(revealing!==controller)return;
  if(!response.ok)throw new Error(result.error??"저장된 인증 정보를 확인할 수 없습니다.");
  if(result.url!==savedUrl||result.authType!==savedAuthType||typeof result.secret!=="string")
   throw new Error("저장된 인증이 변경됐습니다. 연결을 다시 확인해 주세요.");
  secretInput.value=result.secret;secretInput.type="text";
 }catch(error){if(!controller.signal.aborted)element("remote-config-status").textContent=error.message;}
 finally{if(revealing===controller){revealing=undefined;render();}}
};
secretInput.addEventListener("focus",()=>{if(usingSavedSecret&&secretInput.value)secretInput.select();});
for(const id of ["remote-url","remote-secret","remote-agent","remote-auth-type"])element(id).addEventListener("input",()=>{
 if(!idle()||configuring)return;
 if(id==="remote-secret")usingSavedSecret=false;
 else{
  maskSecret();
  if(usingSavedSecret&&!canReuseSecret()){secretInput.value="";usingSavedSecret=false;}
 }
 revealing?.abort();revealing=undefined;
 ready=false;generation++;checking?.abort();element("setup").textContent="변경한 원격 설정을 적용해 주세요.";render();
});
element("login").onclick=async()=>{
 if(loggingIn||!idle()||selected!=="claude")return;
 loggingIn=true;element("setup").textContent="열린 브라우저 창에서 Claude 로그인을 완료해 주세요…";render();
 try{
  const response=await fetch("/api/providers/claude/login",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"});
  const result=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(result.error??"브라우저 로그인을 완료하지 못했습니다. 터미널에서 claude auth login을 실행해 주세요.");
  loggingIn=false;if(selected==="claude")await choose("claude");
 }catch(error){if(selected==="claude")element("setup").textContent=error.message;}
 finally{loggingIn=false;render();}
};
async function startCall(){
 if(directCall&&!ready)await choose("openclaw");
 if(!ready)return;
 speakerMuted=false;
 maskSecret();render();await huddle?.start();
}
element("start").onclick=()=>{void startCall();};
element("resume-audio").onclick=()=>{void resumeAudio?.().catch(()=>{});};
element("speaker").onclick=()=>{
 speakerMuted=!speakerMuted;if(speakerMuted)clearOutput?.();
 render();
};
element("toggle-transcript").onclick=()=>{
 const toggle=element("toggle-transcript");
 const open=toggle.getAttribute("aria-expanded")!=="true";
 toggle.setAttribute("aria-expanded",String(open));
 element("call-layout").dataset.transcriptOpen=String(open);
};
element("mute").onclick=()=>huddle?.mute();
element("interrupt").onclick=()=>{void huddle?.interrupt();};
element("stop").onclick=async()=>{
 const call=huddle;await call?.leave();
 if(call===huddle&&!element("start").disabled)element("start").focus({preventScroll:true});
};
window.addEventListener("pagehide",()=>{clearInterval(clock);maskSecret();generation++;checking?.abort();off?.();void huddle?.dispose();});
try{selected=Object.hasOwn(names,localStorage.getItem("huddle-ai"))?localStorage.getItem("huddle-ai"):"codex";}catch{}
try{const savedMode=localStorage.getItem("huddle-openclaw-mode");if(["remote","remote-realtime"].includes(savedMode))remoteMode=savedMode;element("remote-url").value=localStorage.getItem("huddle-openclaw-url")??"";}catch{}
element("openclaw-mode").value=remoteMode;
if(directCall||new URLSearchParams(location.search).get("openclaw")==="remote"){
 selected="openclaw";remoteMode="remote";element("openclaw-mode").value=remoteMode;
}
if(directCall){element("call-actions").append(element("mute"));animateCallBackdrop();}
void choose(selected);
