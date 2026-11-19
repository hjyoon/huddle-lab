import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createLocalSpeechBackend } from "./local-speech.mjs";
import { runOwned } from "./claude-process.mjs";
import { completeSpokenReply, spokenReplyInstructions } from "./openclaw-spoken-reply.mjs";

class GatewayError extends Error {
  constructor(message, { rejected = false, runNotFound = false, missingWorkerWorkspace = false } = {}) {
    super(message);
    this.rejected = rejected;
    this.runNotFound = runNotFound;
    this.missingWorkerWorkspace = missingWorkerWorkspace;
  }
}

const DEFAULT_VOICE_AGENT = "huddle-voice";

function runFailure(result) {
  const detail = typeof result.error === "string" ? result.error : result.error?.message ?? "";
  if (/worker session source is unavailable(?: or changed during admission)?/i.test(detail)) {
    return new GatewayError("운영 OpenClaw Worker가 Huddle 통화 세션을 열지 못했습니다. Gateway의 Worker 세션 연결을 확인해 주세요.");
  }
  if (/node worker (?:launch failed|supervisor receipt identity mismatch)/i.test(detail)) {
    const error = new GatewayError("운영 OpenClaw Worker가 모델 실행을 시작하지 못했습니다. Gateway의 Worker 실행 상태를 확인해 주세요.");
    error.fatal = /cancellation could not be confirmed|cancellation timed out/i.test(detail);
    return error;
  }
  if (/no api key found|invalid api key|authentication failed|missing credentials|invalid_grant/i.test(detail)) {
    return new GatewayError("원격 모델 제공자가 인증을 거절했습니다. 운영 OpenClaw의 모델 인증을 확인해 주세요.");
  }
  return new GatewayError("원격 Gateway에서 모델 실행이 실패했습니다. 운영 Gateway의 실행 로그를 확인해 주세요.");
}

/** CLI/Gateway output can contain secrets. Return only messages we own. */
function gatewayFailure(cliError, response, method) {
  const detail = response?.error;
  const diagnostic = [detail?.type,detail?.kind,detail?.code,detail?.details?.code,detail?.message,detail?.reason,cliError?.stderr]
    .filter(value=>typeof value==="string").join(" ");
  const rejected={rejected:true};
  const upgradeStatus=diagnostic.match(/(?:rejected websocket upgrade \(HTTP |unexpected server response:\s*)([45]\d{2})\b/i)?.[1];
  if(upgradeStatus&&["502","503","504"].includes(upgradeStatus))
    return new GatewayError(`원격 Gateway가 HTTP ${upgradeStatus}를 반환했습니다. 운영 Gateway가 준비된 뒤 연결을 다시 확인해 주세요.`,rejected);
  if(cliError?.code==="ENOENT")return new GatewayError("이 Mac에서 OpenClaw CLI를 찾을 수 없습니다. Huddle 서버의 OpenClaw 실행 경로를 확인해 주세요.",rejected);
  if(/AUTH_RATE_LIMITED|too many (?:failed )?(?:authentication|auth) attempts|rate limit.*auth/i.test(diagnostic))
    return new GatewayError("Gateway가 인증 시도를 일시 제한했습니다. 잠시 기다린 뒤 올바른 토큰 또는 비밀번호를 적용해 주세요.",rejected);
  if(/NOT_PAIRED|PAIRING_REQUIRED|pairing required|device identity required|DEVICE_IDENTITY_REQUIRED|device token mismatch|AUTH_DEVICE_TOKEN_MISMATCH/i.test(diagnostic))
    return new GatewayError(method==="health"
      ? "원격 Gateway의 기기 승인이 필요합니다. 원격 OpenClaw의 Devices에서 이 Mac의 요청을 승인한 뒤 다시 확인해 주세요."
      : "이 Mac에 원격 실행 권한(operator.write) 승인이 필요합니다. 운영 OpenClaw의 Devices에서 해당 권한 요청을 승인한 뒤 다시 확인해 주세요.",rejected);
  if(/missing scope|INSUFFICIENT_SCOPE|forbidden scope|AUTH_SCOPE_MISMATCH|scope upgrade/i.test(diagnostic))
    return new GatewayError(method==="health"
      ? "이 기기에 Gateway 조회 권한(operator.read)이 없습니다. 운영 OpenClaw에서 기기 권한을 확인해 주세요."
      : "이 기기에 원격 실행 권한(operator.write)이 없습니다. 운영 OpenClaw에서 기기의 실행 권한을 확인해 주세요.",rejected);
  if(/AUTH_(?:TOKEN|PASSWORD)_(?:MISSING|MISMATCH)|\b(?:token|password) (?:is )?(?:missing|mismatch|invalid|incorrect)|gateway_credentials_required|unauthorized/i.test(diagnostic))
    return new GatewayError("Gateway가 인증 정보를 거절했습니다. 원격 Gateway의 인증 방식과 토큰 또는 비밀번호를 확인해 주세요.",rejected);
  if(method==="agent.wait"&&detail?.type==="gateway_request_error"&&detail.code==="INVALID_REQUEST"&&detail.message==="agent run was not found")
    return new GatewayError("Gateway에서 해당 실행을 찾지 못했습니다.",{rejected:true,runNotFound:true});
  if (method === "sessions.reclaim" && detail?.type === "gateway_request_error" &&
      detail.code === "INVALID_REQUEST" &&
      detail.message === "sessions.reclaim requires the session-owned worktree, repository workspace, or device folder") {
    return new GatewayError("Huddle 세션의 Worker 작업 공간을 찾지 못했습니다.", { rejected: true, missingWorkerWorkspace: true });
  }
  if(/protocol mismatch|unsupported protocol|unknown method|invalid connect|incompatible protocol|invalid (?:agent|chat\.abort) params/i.test(diagnostic))
    return new GatewayError("OpenClaw CLI와 원격 Gateway의 프로토콜 또는 요청 형식이 호환되지 않습니다. 양쪽 버전을 확인해 주세요.",rejected);
  if(detail?.type==="gateway_request_error"&&detail.code==="INVALID_REQUEST")
    return new GatewayError("원격 Gateway가 실행 요청을 거절했습니다. 원격 에이전트의 설정과 Gateway 로그를 확인해 주세요.",rejected);
  if(/certificate|self.signed|unable to verify|CERT_|ERR_TLS/i.test(diagnostic))
    return new GatewayError("원격 Gateway의 TLS 인증서를 검증하지 못했습니다. 주소와 인증서 신뢰 설정을 확인해 주세요.");
  if(/ENOTFOUND|EAI_AGAIN|no such host|getaddrinfo/i.test(diagnostic))
    return new GatewayError("Gateway 주소를 찾을 수 없습니다. 호스트 이름과 네트워크 또는 VPN을 확인해 주세요.");
  if(cliError?.code==="ETIMEDOUT"||/\btimeout\b|timed out|ETIMEDOUT/i.test(diagnostic))
    return new GatewayError("원격 Gateway 응답 시간이 초과됐습니다. 네트워크 또는 Gateway 상태를 확인한 뒤 다시 시도해 주세요.");
  if(/unexpected server response|ECONNREFUSED|ECONNRESET|gateway closed|socket hang up/i.test(diagnostic))
    return new GatewayError("Gateway WebSocket 연결이 끊겼거나 거절됐습니다. 주소, 경로와 네트워크를 확인해 주세요.");
  return new GatewayError("OpenClaw CLI가 Gateway 연결 또는 요청을 완료하지 못했습니다. CLI 실행 상태와 Gateway 로그를 확인해 주세요.");
}

export function validateRemoteSettings(value) {
  if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).some(key=>!["url","token","password","agent"].includes(key)))throw new Error("원격 Gateway 설정 형식을 확인해 주세요.");
  let url;try{url=new URL(value.url);}catch{throw new Error("Gateway WebSocket 주소를 입력해 주세요.");}
  if(typeof value.url!=="string"||value.url.length>2048||url.username||url.password||url.search||url.hash||
    (url.protocol!=="wss:"&&!(url.protocol==="ws:"&&["127.0.0.1","localhost","[::1]"].includes(url.hostname))))
    throw new Error("원격 주소는 wss://, SSH 터널은 ws://localhost를 사용해 주세요. 인증 정보는 별도 입력란에 넣어 주세요.");
  for(const key of ["token","password"])if(value[key]!==undefined&&(typeof value[key]!=="string"||value[key].length>4096||/[\r\n\0]/.test(value[key])))throw new Error("Gateway 인증 정보를 확인해 주세요.");
  if(value.token&&value.password)throw new Error("토큰과 비밀번호 중 하나를 선택해 주세요.");
  if(!value.token&&!value.password)throw new Error("Gateway 토큰 또는 비밀번호를 입력해 주세요. 원격 주소 지정 시 CLI는 명시적인 인증을 요구합니다.");
  const agent=value.agent||undefined;
  if(agent!==undefined&&(typeof agent!=="string"||!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(agent)))throw new Error("에이전트 ID는 영문·숫자로 시작하고 영문·숫자·밑줄·하이픈으로 64자까지 입력할 수 있습니다.");
  return{url:url.href,token:value.token||undefined,password:value.password||undefined,agent:agent?.toLowerCase()};
}

/** The CLI handles Gateway pairing. Each voice call owns one Gateway session. */
export function createRemoteOpenClawBackend({cwd=process.cwd(),runtimeRoot=resolve(cwd,".huddle-runtime/claude"),
  binary="openclaw",remote,python,model="base",language="ko",voice="Yuna",run=runOwned}={}) {
  const settings=remote?.url?validateRemoteSettings(remote):undefined;
  const speech=createLocalSpeechBackend({cwd,runtimeRoot,...(python?{python}:{}),model,language,voice,run});
  let selectedAgent,blocked;
  const env=settings?{...process.env,OPENCLAW_GATEWAY_URL:settings.url,OPENCLAW_GATEWAY_TOKEN:settings.token??"",OPENCLAW_GATEWAY_PASSWORD:settings.password??""}:undefined;
  const call=async(method,params={},signal,timeout=15000)=>{
    if(!settings)throw new GatewayError("화면에서 원격 Gateway 주소와 인증 정보를 입력해 주세요.");
    let raw;
    try{
      raw=await run(binary,["gateway","call",method,"--json","--timeout",String(timeout),"--params",JSON.stringify(params)],
        {cwd,env,signal,timeoutMs:timeout+5000,captureFailureOutput:true});
    }catch(error){
      signal?.throwIfAborted();
      let response;
      try{response=JSON.parse(error?.stdout??"");}catch{}
      throw gatewayFailure(error,response,method);
    }
    let response;
    try{response=JSON.parse(raw);}catch{
      throw new GatewayError("OpenClaw CLI가 Gateway 응답을 JSON으로 반환하지 않았습니다. CLI 버전과 설정을 확인해 주세요.");
    }
    if(!response||typeof response!=="object"||Array.isArray(response))throw new GatewayError("Gateway 응답 형식을 확인할 수 없습니다.");
    if(response.ok===false&&response.error)throw gatewayFailure(undefined,response,method);
    return response;
  };
  async function inspectRunAccess() {
    // agent.wait uses the same operator.write scope as agent and chat.abort.
    // An unknown ID checks access without starting or touching any run.
    try {
      const probe=await call("agent.wait",{runId:`huddle-check-${randomUUID()}`,timeoutMs:500},undefined,15000);
      if(probe.status!=="timeout")throw new GatewayError("Gateway의 실행 상태 조회 응답이 예상 형식과 다릅니다. Gateway 버전을 확인해 주세요.");
    } catch(error) {
      if(!(error instanceof GatewayError&&error.runNotFound))throw error;
    }
  }
  async function abortRun(sessionKey,runId,agentId) {
    // Never cancel a whole agent/session: this ID belongs only to this utterance.
    const result=await call("chat.abort",{sessionKey,runId,agentId},undefined,10000);
    if(result.ok!==true)throw new Error("Remote Gateway did not acknowledge cancellation.");
    // An acknowledged abort is a request; confirm the owned run is terminal.
    const terminal=await call("agent.wait",{runId,timeoutMs:10000},undefined,12000);
    if(!["ok","error"].includes(terminal.status)||terminal.pendingError===true)throw new Error("Remote generation has not stopped.");
  }
  const backend={
    ...speech,
    async inspect(){
      const result={workspace:cwd,engine:"OpenClaw",mode:"remote",tools:false,modelName:"Gateway 기본 모델"};
      let checkingSpeech=false;
      try{
        if(blocked)throw new Error(blocked);
        const health=await call("health");
        if(health.ok!==true)throw new GatewayError("Gateway에 연결했지만 정상 상태를 확인하지 못했습니다. 원격 Gateway의 상태를 확인해 주세요.");
        const agents=Array.isArray(health.agents)?health.agents:[];
        const agent=settings.agent??DEFAULT_VOICE_AGENT;
        if(agents.length&&!agents.some(item=>item?.agentId===agent))
          throw new GatewayError("Gateway에 연결했습니다. 설정한 전용 Huddle 에이전트가 원격 Gateway에 없습니다.");
        await inspectRunAccess();
        result.agentId=agent;result.version="OpenClaw 원격 Gateway";
        checkingSpeech=true;
        Object.assign(result,await speech.inspectSpeech());selectedAgent=agent;result.ready=true;
      }catch(error){
        selectedAgent=undefined;
        result.ready=false;result.error=blocked??(error instanceof GatewayError||checkingSpeech?error.message:"원격 Gateway 연결 상태를 확인하지 못했습니다.");
      }
      return result;
    },
    async openSession() {
      if (blocked) throw new GatewayError(blocked);
      if (!selectedAgent) {
        const status = await backend.inspect();
        if (!status.ready) throw new GatewayError(status.error);
      }
      const agentId = selectedAgent;
      const idempotencyKey = randomUUID();
      const key = `agent:${agentId}:huddle:${idempotencyKey}`;
      let created;
      try {
        created = await call("sessions.create", {
          key, agentId, idempotencyKey, displayName: "Huddle 음성 통화", emitCommandHooks: false,
        });
        if (created.ok !== true || created.key !== key ||
            typeof created.sessionId !== "string" || !created.sessionId || created.runStarted === true) {
          throw new GatewayError("Gateway가 통화 세션을 확인하지 못했습니다.");
        }
      } catch (error) {
        if (error.rejected) throw error;
        blocked = "Gateway의 통화 세션 생성을 확인하지 못했습니다. Gateway에서 세션 상태를 확인한 뒤 원격 설정을 다시 적용해 주세요.";
        throw new GatewayError(blocked);
      }
      const { key: sessionKey, sessionId } = created;
      let closing;
      const close = () => closing ??= (async () => {
        if (blocked) return;
        try {
          const receipt = await call("sessions.reclaim", { key: sessionKey }, undefined, 45000);
          if (receipt.ok === true && receipt.key === sessionKey && receipt.sessionId === sessionId &&
              ["reclaimed", "local"].includes(receipt.placement?.state)) return;
        } catch (error) {
          if (!error.missingWorkerWorkspace || created.worktree) throw error;
          // A standalone Gateway can keep this call in its ordinary agent workspace.
          const { session } = await call("sessions.describe", { key: sessionKey });
          if (session?.key === sessionKey && session.sessionId === sessionId &&
              (!session.workerPlacement || session.workerPlacement.state === "local")) return;
        }
        throw new GatewayError("Huddle 통화의 Worker 회수를 확인하지 못했습니다.");
      })();
      try {
        const inventory = await call("tools.effective", { sessionKey });
        if (inventory.agentId !== agentId || !Array.isArray(inventory.groups) ||
            inventory.groups.some(group => !Array.isArray(group.tools) ||
              group.tools.some(tool => tool.deniedBySession !== true)) ||
            inventory.notices?.some(notice => notice.id.startsWith("mcp-") && notice.servers?.length)) {
          throw new GatewayError("원격 Huddle 에이전트의 도구 사용을 차단한 뒤 다시 연결해 주세요.");
        }
      } catch (error) {
        await close().catch(() => {});
        throw error;
      }
      return {
        close,
        async reply(history, signal) {
          signal?.throwIfAborted();
          if (blocked || closing) throw new GatewayError(blocked ?? "Huddle 통화가 이미 종료됐습니다.");
          const latest = history.at(-1);
          if (latest?.role !== "user" || typeof latest.content !== "string" || !latest.content.trim()) {
            throw new GatewayError("Huddle 발화가 비어 있습니다.");
          }
          const message = `${spokenReplyInstructions}\n\n${latest.content}`;
          const runId = randomUUID();
          let accepted = false;
          let finished = false;
          const timeout = new AbortController();
          const timer = setTimeout(() => timeout.abort(new GatewayError("원격 모델의 응답 대기 시간이 초과됐습니다.")), 60000);
          const workSignal = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
          try {
            // Wait for the acknowledgement so an interrupt can target its exact run.
            const start = await call("agent", { agentId, sessionKey, message, deliver: false, idempotencyKey: runId });
            if (start.runId !== runId || start.status !== "accepted") {
              throw new GatewayError("Gateway가 실행 접수를 예상한 형식으로 응답하지 않았습니다.");
            }
            accepted = true;
            workSignal.throwIfAborted();
            const result = await call("agent.wait", { runId, timeoutMs: 60000 }, workSignal, 65000);
            workSignal.throwIfAborted();
            if (!["ok", "error"].includes(result.status) || result.pendingError === true) {
              throw new GatewayError("Gateway에서 원격 모델의 완료 결과를 받지 못했습니다.");
            }
            finished = true;
            if (result.status === "error") {
              const error = runFailure(result);
              if (error.fatal) blocked = `${error.message} 실행 종료가 확인된 뒤 이 연결을 다시 적용해 주세요.`;
              throw error;
            }
            if (result.terminalReply?.disposition !== "visible" ||
                typeof result.terminalReply.text !== "string" || !result.terminalReply.text.trim()) {
              throw new GatewayError("원격 모델 실행은 끝났지만 읽어 줄 수 있는 완료 답변이 반환되지 않았습니다.");
            }
            return completeSpokenReply(result.terminalReply.text.trim()).slice(0, 1200);
          } catch (error) {
            if (!accepted && error instanceof GatewayError && error.rejected) throw error;
            if (!finished) {
              try {
                await abortRun(sessionKey, runId, agentId);
              } catch (cancelError) {
                const cause = error instanceof GatewayError ? error.message :
                  cancelError instanceof GatewayError ? cancelError.message : "";
                blocked = [cause, "해당 원격 실행의 종료를 확인하지 못했습니다. Gateway에서 실행 상태를 확인한 뒤 원격 설정을 다시 적용해 주세요."].filter(Boolean).join(" ");
              }
              if (!accepted) blocked ??= "Gateway의 실행 접수를 확인하지 못했습니다. Gateway에서 실행 상태를 확인한 뒤 원격 설정을 다시 적용해 주세요.";
            }
            if (blocked) {
              const failure = new GatewayError(blocked);
              failure.fatal = true;
              throw failure;
            }
            throw error;
          } finally {
            clearTimeout(timer);
          }
        },
      };
    },
  };
  return backend;
}
