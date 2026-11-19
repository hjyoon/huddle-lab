import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createLocalSpeechBackend } from "./local-speech.mjs";
import { immediateReplyInstructions } from "./spoken-reply.mjs";

/** Hermes Agent voice backend over the Hermes API server's Runs API.
 * Speech stays on this Mac; only the recognized text reaches Hermes. Each call
 * owns one Hermes session, and each utterance is one run that is stopped and
 * confirmed terminal before the next utterance starts. */

const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted"]);
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

export const hermesSpokenReplyInstructions = [
  immediateReplyInstructions,
  "This turn comes from a live voice call (Huddle). The answer is read aloud by a speech synthesizer, so do not use Markdown, lists, tables, code blocks, URLs or emoji.",
  "You may use your tools when the user needs live information or asks for an action, but keep the call responsive and finish within this turn.",
  "Do not start background work, cron jobs or delegated tasks that report later; the caller cannot receive a follow-up message.",
].join(" ");

class HermesError extends Error {
  constructor(message, { rejected = false, fatal = false } = {}) {
    super(message);
    this.rejected = rejected;
    this.fatal = fatal;
  }
}

export function validateHermesSettings(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some(key => !["url", "apiKey"].includes(key))) {
    throw new Error("Hermes 설정 형식을 확인해 주세요.");
  }
  let url;
  try { url = new URL(value.url); } catch { throw new Error("Hermes API 서버 주소를 입력해 주세요."); }
  if (typeof value.url !== "string" || value.url.length > 2048 || url.username || url.password || url.search || url.hash ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname)))) {
    throw new Error("Hermes 주소는 https://, SSH 터널은 http://127.0.0.1을 사용해 주세요. API 키는 주소에 넣지 마세요.");
  }
  if (typeof value.apiKey !== "string" || !value.apiKey || value.apiKey.length > 4096 || /[\s\0]/.test(value.apiKey)) {
    throw new Error("Hermes API 키(API_SERVER_KEY)를 설정해 주세요.");
  }
  const base = url.href.replace(/\/+$/, "").replace(/\/v1$/, "");
  return { url: base, apiKey: value.apiKey };
}

/** Error messages are ours: response bodies may echo request data. */
function httpFailure(status) {
  if (status === 401 || status === 403) return new HermesError("Hermes API 서버가 인증을 거절했습니다. API_SERVER_KEY를 확인해 주세요.", { rejected: true });
  if (status === 404) return new HermesError("Hermes API 서버에서 Runs API를 찾지 못했습니다. Hermes 버전을 확인해 주세요.", { rejected: true });
  if (status === 429) return new HermesError("Hermes API 서버가 요청을 제한했습니다. 잠시 뒤 다시 말해 주세요.", { rejected: true });
  if (status === 503) return new HermesError("Hermes가 재시작 또는 종료 중입니다. 잠시 뒤 다시 시도해 주세요.", { rejected: true });
  return new HermesError(`Hermes API 서버가 HTTP ${status}로 응답했습니다. Hermes 게이트웨이 로그를 확인해 주세요.`, { rejected: true });
}

function networkFailure(error) {
  const code = error?.cause?.code ?? error?.cause?.errors?.[0]?.code ?? error?.code ?? "";
  if (code === "ECONNREFUSED") return new HermesError("Hermes API 서버에 연결할 수 없습니다. SSH 터널 또는 API 서버 실행 상태를 확인해 주세요.");
  if (/ENOTFOUND|EAI_AGAIN/.test(code)) return new HermesError("Hermes 주소를 찾을 수 없습니다. 호스트 이름과 네트워크를 확인해 주세요.");
  if (/CERT|TLS|SELF_SIGNED/i.test(code)) return new HermesError("Hermes API 서버의 TLS 인증서를 검증하지 못했습니다.");
  if (error?.name === "TimeoutError") return new HermesError("Hermes API 서버 응답 시간이 초과됐습니다.");
  return new HermesError("Hermes API 서버와 통신하지 못했습니다. 네트워크와 API 서버 상태를 확인해 주세요.");
}

export function createHermesBackend({cwd=process.cwd(),runtimeRoot=resolve(cwd,".huddle-runtime/claude"),settings,
  python,model="base",language="ko",voice="Yuna",run,speech,fetch:request=globalThis.fetch,
  replyTimeoutMs=120000,stopTimeoutMs=15000,pollMs=400}={}) {
  let config, configError;
  try { config = settings?.url || settings?.apiKey ? validateHermesSettings(settings) : undefined; }
  catch (error) { configError = error.message; }
  speech ??= createLocalSpeechBackend({cwd,runtimeRoot,...(python?{python}:{}),model,language,voice,...(run?{run}:{})});
  let blocked;

  async function call(method, path, { body, signal, timeoutMs = 15000, headers = {} } = {}) {
    if (!config) throw new HermesError(configError ?? "HUDDLE_HERMES_URL과 HUDDLE_HERMES_KEY를 설정한 뒤 Huddle을 다시 실행해 주세요.", { rejected: true });
    const timeout = AbortSignal.timeout(timeoutMs);
    let response;
    try {
      response = await request(`${config.url}${path}`, {
        method,
        headers: { Authorization: `Bearer ${config.apiKey}`, Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (error) {
      signal?.throwIfAborted();
      throw networkFailure(error);
    }
    if (!response.ok) { await response.body?.cancel().catch(() => {}); throw httpFailure(response.status); }
    let value;
    try { value = await response.json(); } catch { throw new HermesError("Hermes API 서버가 JSON이 아닌 응답을 반환했습니다."); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new HermesError("Hermes API 응답 형식을 확인할 수 없습니다.");
    return value;
  }

  async function waitTerminal(runId, signal, timeoutMs, { stopOnApproval = false } = {}) {
    const end = Date.now() + timeoutMs;
    for (;;) {
      signal?.throwIfAborted();
      const state = await call("GET", `/v1/runs/${encodeURIComponent(runId)}`, { signal });
      if (state.run_id !== undefined && state.run_id !== runId) throw new HermesError("Hermes가 다른 실행의 상태를 반환했습니다.", { fatal: true });
      if (TERMINAL.has(state.status) || (stopOnApproval && state.status === "waiting_for_approval")) return state;
      if (Date.now() >= end) throw new HermesError("Hermes의 응답 대기 시간이 초과됐습니다.");
      try { await delay(pollMs, undefined, signal ? { signal } : undefined); }
      catch (error) { signal?.throwIfAborted(); throw error; }
    }
  }

  async function stopRun(runId) {
    // Stop only this utterance's run, then confirm it is terminal.
    try { await call("POST", `/v1/runs/${encodeURIComponent(runId)}/stop`, { body: {} }); }
    catch (error) { if (!(error instanceof HermesError) || !error.rejected) throw error; }
    const state = await waitTerminal(runId, undefined, stopTimeoutMs);
    return state.status;
  }

  const backend = {
    ...speech,
    async inspect() {
      const result = { workspace: cwd, engine: "Hermes", modelName: "Hermes Agent" };
      let checkingSpeech = false;
      try {
        if (blocked) throw new Error(blocked);
        const capabilities = await call("GET", "/v1/capabilities");
        const features = capabilities.features ?? {};
        if (features.run_submission !== true || features.run_status !== true || features.run_stop !== true) {
          throw new HermesError("이 Hermes 버전은 실행 취소를 지원하지 않습니다. Hermes를 업데이트해 주세요.");
        }
        if (typeof capabilities.model === "string" && capabilities.model) result.modelName = capabilities.model;
        result.version = "Hermes Agent API";
        checkingSpeech = true;
        Object.assign(result, await speech.inspectSpeech());
        result.ready = true;
      } catch (error) {
        result.ready = false;
        result.error = blocked ?? (error instanceof HermesError || checkingSpeech ? error.message : "Hermes 연결 상태를 확인하지 못했습니다.");
      }
      return result;
    },
    async openSession() {
      if (blocked) throw new HermesError(blocked);
      // A fresh session per call: Hermes keeps this call's turns and tool results.
      const sessionId = `huddle-${randomUUID()}`;
      let closed = false;
      return {
        sessionId,
        async close() { closed = true; },
        async reply(history, signal) {
          signal?.throwIfAborted();
          if (blocked || closed) throw new HermesError(blocked ?? "Huddle 통화가 이미 종료됐습니다.");
          const latest = history.at(-1);
          if (latest?.role !== "user" || typeof latest.content !== "string" || !latest.content.trim()) {
            throw new HermesError("Huddle 발화가 비어 있습니다.");
          }
          const idempotencyKey = randomUUID();
          let runId, finished = false;
          const timeout = new AbortController();
          const timer = setTimeout(() => timeout.abort(new HermesError("Hermes의 응답 대기 시간이 초과됐습니다.")), replyTimeoutMs);
          const workSignal = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
          try {
            // Not tied to the caller's signal: an interrupt must learn the run ID to stop it.
            const submit = () => call("POST", "/v1/runs", {
              body: { input: latest.content, instructions: hermesSpokenReplyInstructions, session_id: sessionId },
              headers: { "Idempotency-Key": idempotencyKey },
            });
            let started;
            try { started = await submit(); }
            catch (error) {
              if (error.rejected) throw error;
              // The admission may have happened. The same key returns that run instead of a new one.
              started = await submit();
            }
            if (typeof started.run_id !== "string" || !started.run_id) throw new HermesError("Hermes가 실행 ID를 반환하지 않았습니다.");
            runId = started.run_id;
            const state = await waitTerminal(runId, workSignal, replyTimeoutMs, { stopOnApproval: true });
            if (state.status === "waiting_for_approval") {
              // Nobody on a voice call can approve a dangerous command; stop instead of hanging.
              throw new HermesError("Hermes가 승인이 필요한 작업을 요청해서 이번 답변을 중단했습니다. 그 작업은 승인할 수 있는 채팅에서 요청해 주세요.");
            }
            finished = true;
            if (state.status !== "completed") {
              throw new HermesError(state.status === "failed"
                ? "Hermes 실행이 실패했습니다. Hermes 게이트웨이 로그를 확인해 주세요."
                : "Hermes 실행이 중단됐습니다. 다시 말해 주세요.");
            }
            const text = typeof state.output === "string" ? state.output.trim() : "";
            if (!text) throw new HermesError("Hermes 실행은 끝났지만 읽어 줄 답변이 없습니다.");
            return spokenText(text);
          } catch (error) {
            if (!runId && !(error instanceof HermesError && error.rejected)) {
              blocked = "Hermes의 실행 접수 여부를 확인하지 못했습니다. Hermes에서 실행 상태를 확인한 뒤 Huddle을 다시 시작해 주세요.";
            }
            if (runId && !finished) {
              try { await stopRun(runId); }
              catch {
                blocked = "Hermes 실행의 종료를 확인하지 못했습니다. Hermes에서 실행 상태를 확인한 뒤 Huddle을 다시 시작해 주세요.";
              }
            }
            if (blocked) throw new HermesError(blocked, { fatal: true });
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

/** Strip Markdown that a speech synthesizer would read literally. */
export function spokenText(text) {
  const plain = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, "")
    .replace(/(\*\*|__|\*|_|~~)(\S(?:.*?\S)?)\1/g, "$2")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
  if (plain.length <= 1200) return plain;
  const cut = plain.slice(0, 1200);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("다. "), cut.lastIndexOf("요. "), cut.lastIndexOf("\n"));
  return (end > 600 ? cut.slice(0, end + 1) : cut).trim();
}
