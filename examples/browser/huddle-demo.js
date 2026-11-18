import { createAgentHuddle } from "../../dist/agent-voice/index.js";
import { openWebAudio } from "../../dist/web-audio/index.js";
import { createCodexVoiceProvider,createCodexLocalConnector } from "../../dist/codex-voice/index.js";
import { createClaudeVoiceProvider } from "../../dist/claude-voice/index.js";
import { createOpenClawVoiceProvider } from "../../dist/openclaw-voice/index.js";
const element=id=>document.getElementById(id);
const names={codex:"Codex",claude:"Claude",openclaw:"OpenClaw"};
let huddle,off,ready=false,selected="codex",generation=0,checking;
const idle=()=>!huddle||["idle","error"].includes(huddle.snapshot().phase);
const render=()=>{
 const state=huddle?.snapshot(),phase=state?.phase??"idle",connected=phase==="connected";
 element("provider").disabled=!["idle","error"].includes(phase);
 element("start").disabled=!ready||!["idle","error"].includes(phase);
 element("start").textContent=`${names[selected]}와 통화 시작`;
 element("mute").disabled=!connected;element("interrupt").disabled=!connected||!["thinking","speaking"].includes(state.activity);
 element("stop").disabled=!["connecting","connected"].includes(phase);
 element("mute").textContent=state?.muted?"마이크 음소거 해제":"마이크 음소거";element("mute").setAttribute("aria-pressed",String(state?.muted??false));
 element("status").textContent=({idle:"대기 중",connecting:`${names[selected]} 연결 중`,connected:"통화 중",leaving:"종료 중",error:"연결 실패"})[phase];
 element("activity").textContent=({idle:"대기",listening:"듣는 중",thinking:"답변 준비 중",speaking:"말하는 중"})[state?.activity??"idle"];
 element("error").textContent=state?.error??"";
 element("transcripts").replaceChildren(...(state?.transcripts??[]).map(row=>{const li=document.createElement("li");li.textContent=`${row.speaker==="user"?"사용자":names[selected]}: ${row.text}`;return li;}));
};
async function choose(id){
 if(!Object.hasOwn(names,id)||!idle()){element("provider").value=selected;return;}
 const token=++generation;checking?.abort();checking=new AbortController();const signal=checking.signal;
 const previous=huddle;off?.();off=undefined;huddle=undefined;ready=false;selected=id;
 element("provider").value=id;
 try{localStorage.setItem("huddle-ai",id);}catch{}
 element("setup").textContent=`${names[id]} 설치 및 연결 상태 확인 중…`;element("workspace").textContent="확인 중";
 element("description").textContent=id==="codex"?"Codex와 실시간 음성으로 대화합니다. 통화 음성은 Codex의 실시간 서비스로 전송합니다.":id==="claude"?"Claude Code와 음성으로 대화합니다. 음성 인식·합성은 이 Mac에서 처리하고 인식한 대화 내용은 Claude 서비스로 전송합니다.":"OpenClaw에 설정된 모델과 음성으로 대화합니다. 음성 인식·합성은 이 Mac에서 처리하고 인식한 대화 내용은 설정된 모델 서비스로 전송합니다.";
 element("hint").textContent=id==="codex"?"AI가 말하는 중에도 다시 말할 수 있습니다. 응답 중단 버튼은 같은 대화의 음성 채널을 다시 연결합니다.":"말을 마친 뒤 잠시 쉬면 답변합니다. AI가 말할 때 다시 말하면 응답을 중단합니다. 한 번에 30초까지 말할 수 있습니다.";
 render();
 try{
  await previous?.dispose();if(token!==generation)return;
  const result=await fetch(`/api/providers/${id}`,{signal});if(!result.ok)throw new Error("AI 상태를 확인할 수 없습니다.");
  const status=await result.json();if(token!==generation)return;
  element("workspace").textContent=status.workspace??"확인할 수 없음";
  ready=!!status.ready&&!status.busy;
  element("setup").textContent=ready?`${status.version} · ${id!=="codex"?`로컬 음성 엔진 준비됨${status.modelName?` · ${status.modelName}`:""}`:"연결 준비됨"}`:(status.error??(status.busy?"이미 통화 중입니다. 종료 후 다시 선택해 주세요.":"선택한 AI의 설치·로그인 상태를 확인해 주세요."));
  if(ready){
   const provider=id==="codex"?createCodexVoiceProvider({connect:createCodexLocalConnector(status.wsUrl)}):id==="claude"?createClaudeVoiceProvider({url:status.wsUrl}):createOpenClawVoiceProvider({url:status.wsUrl});
   huddle=createAgentHuddle({provider,openAudio:openWebAudio});off=huddle.subscribe(render);
  }
 }catch(error){if(token===generation&&!signal.aborted)element("setup").textContent=error.message;}
 if(token===generation)render();
}
element("provider").onchange=()=>{void choose(element("provider").value);};
element("start").onclick=()=>{void huddle?.start();};element("mute").onclick=()=>huddle?.mute();element("interrupt").onclick=()=>{void huddle?.interrupt();};element("stop").onclick=()=>{void huddle?.leave();};
window.addEventListener("pagehide",()=>{generation++;checking?.abort();off?.();void huddle?.dispose();});
try{selected=Object.hasOwn(names,localStorage.getItem("huddle-ai"))?localStorage.getItem("huddle-ai"):"codex";}catch{}
void choose(selected);
