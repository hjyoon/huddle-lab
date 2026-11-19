import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve, isAbsolute } from "node:path";
import { stat } from "node:fs/promises";
import { WebSocketServer } from "ws";
import { openCodexRpc } from "./codex-rpc.mjs";
import { serveDemoFile } from "./serve-demo.mjs";
import { immediateReplyInstructions } from "./spoken-reply.mjs";

const run = promisify(execFile);
const text = (value) => String(value ?? "Codex request failed").replace(/[\x00-\x1f]/g, " ").slice(0, 1000);

const OPENCLAW_MAIN_TOOL = {
  type: "function",
  name: "run_openclaw_main",
  description: "Ask the OpenClaw main agent to perform the user's authorized work or retrieve live information. Return its result to the current call.",
  inputSchema: {
    type: "object",
    properties: { task: { type: "string", description: "The requested work, including the relevant spoken context." } },
    required: ["task"],
    additionalProperties: false,
  },
};
const codexWorkInstructions = [
  "The workspace is read-only. Follow the existing tool permission policy.",
  "Answer general questions directly. Delegate code questions to Codex when repository work is needed and allowed. Wait for the result before claiming any findings.",
];
const openClawWorkInstructions = [
  "Answer general questions directly. Delegate when the caller asks for work or live information that needs the OpenClaw agent.",
  "For delegated work, call run_openclaw_main with the user's task. Wait for the tool result and report what the OpenClaw agent actually did or could not do.",
];
const toolResponse = (success, result) => ({ success, contentItems: [{ type: "inputText", text: result }] });

export async function createCodexHost({ port = 4182, cwd = process.cwd(), binary = "codex", model, voiceModel,
  requireChatGpt = false, createGatewayBackend,
  runtimeRoot = resolve(cwd, ".huddle-runtime/codex"), createRpc = openCodexRpc, allowedOrigins = [] } = {}) {
  if (!isAbsolute(cwd) || !(await stat(cwd)).isDirectory()) throw new Error("Choose an existing absolute Codex workspace.");
  let url, active, status, checking;
  const makeRpc = (signal, handleToolCall) => createRpc({ cwd, runtimeRoot, binary, signal, handleToolCall });
  const codexVoiceInstructions = [
    "This is a voice call. Speak Korean by default and follow the user's language preference.",
    immediateReplyInstructions,
    ...(createGatewayBackend ? openClawWorkInstructions : codexWorkInstructions),
    "A turn starting with <realtime_delegation> is a spoken request. Put the result or the specific limitation in the final answer so the voice model can speak it in the same call.",
  ].join(" ");
  const checkAccount = (account) => {
    if (requireChatGpt && account.account?.type !== "chatgpt") {
      throw new Error("이 Codex 음성 모드에는 ChatGPT 로그인이 필요합니다. codex login으로 연결해 주세요.");
    }
    if (!account.account && account.requiresOpenaiAuth !== false) {
      throw new Error("Sign in using codex login before starting voice.");
    }
  };
  async function inspect() {
    if (checking) return checking;
    checking = (async () => {
      let rpc;
      try {
        const version = createRpc === openCodexRpc ? (await run(binary, ["--version"], { cwd, timeout: 5000 })).stdout.trim() : "protocol fixture";
        rpc = await makeRpc();
        const account = await rpc.request("account/read", { refreshToken: false });
        if (requireChatGpt) checkAccount(account);
        status = { installed: true, signedIn: !!account.account, ready: !!account.account || account.requiresOpenaiAuth === false,
          version: text(version), workspace: cwd, mode: "read-only", ...(voiceModel ? { voiceModel } : {}),
          ...(createGatewayBackend ? { delegateAgent: "main" } : {}) };
      } catch (error) { status = { ready: false, workspace: cwd, mode: "read-only", error: text(error.message) }; }
      finally { await rpc?.close().catch(() => {}); checking = undefined; }
      return status;
    })();
    return checking;
  }
  const server = createServer(async (request, response) => {
    if (request.headers.host !== new URL(url).host || (request.headers.origin && request.headers.origin !== url)) {
      response.writeHead(403).end(); return;
    }
    const path = new URL(request.url, url).pathname;
    if (path === "/codex/status" && request.method === "GET") {
      const result = status ?? await inspect();
      response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify({ ...result, busy: !!active }));
      return;
    }
    if (path === "/") request.url = "/examples/browser/codex.html";
    await serveDemoFile(request, response);
  });
  const websocket = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });
  server.on("upgrade", (request, socket, head) => {
    if (request.headers.host !== new URL(url).host ||
      (request.headers.origin !== url && !allowedOrigins.includes(request.headers.origin)) || request.url !== "/codex" || active) {
      socket.end(`HTTP/1.1 ${active ? "409 Conflict" : "403 Forbidden"}\r\nConnection: close\r\n\r\n`); return;
    }
    websocket.handleUpgrade(request, socket, head, (client) => websocket.emit("connection", client));
  });
  websocket.on("connection", (client) => {
    const session = { abort: new AbortController(), rpc: undefined, threadId: undefined, opening: undefined,
      starting: undefined, closing: undefined, realtime: false, turnId: undefined, pending: new Set() };
    active = session;
    const send = (message) => { if (client.readyState === 1) client.send(JSON.stringify(message)); };
    const ensureThread = (params) => {
      if (!session.threadId || params.threadId !== session.threadId) throw new Error("This voice client does not own that Codex thread.");
    };
    async function handleToolCall(params) {
      const task = params?.arguments?.task;
      if (session.closing || !session.realtime || !session.gateway || !session.turnId ||
          params?.threadId !== session.threadId || params?.turnId !== session.turnId ||
          params?.tool !== OPENCLAW_MAIN_TOOL.name || params?.namespace != null ||
          typeof task !== "string" || !task.trim() || task.length > 8000 ||
          Object.keys(params.arguments).some(key => key !== "task")) {
        return toolResponse(false, "현재 Huddle 통화에서 유효한 OpenClaw 업무 요청을 확인하지 못했습니다.");
      }
      if (session.delegation) return toolResponse(false, "이 통화의 OpenClaw 업무를 이미 실행 중입니다.");
      const controller = new AbortController();
      const delegation = { controller };
      session.delegation = delegation;
      delegation.result = (async () => {
        try {
          session.gatewaySession ??= session.gateway.openSession();
          const gateway = await session.gatewaySession;
          controller.signal.throwIfAborted();
          const reply = await gateway.reply([{ role: "user", content: task.trim() }], controller.signal);
          return toolResponse(true, reply);
        } catch (error) {
          if (error.fatal) session.delegationFailure = error;
          return toolResponse(false, text(error.message));
        } finally {
          session.delegation = undefined;
        }
      })();
      return delegation.result;
    }
    const cancelDelegation = async () => {
      const delegation = session.delegation;
      delegation?.controller.abort(new Error("현재 통화의 OpenClaw 요청을 중단했습니다."));
      await delegation?.result;
      if (session.delegationFailure) throw session.delegationFailure;
    };
    const open = () => {
      if (session.opening) return session.opening;
      session.opening = (async () => {
        session.gateway = createGatewayBackend?.();
        session.rpc = await makeRpc(session.abort.signal, session.gateway ? handleToolCall : undefined);
        session.rpc.subscribe((message) => {
          const params = message.params ?? {};
          if (message.method === "connection/closed") {
            send({ method: "connection/closed", params: { message: "Codex app-server disconnected." } });
            void close(true).catch(() => {});
            return;
          }
          if (params.threadId !== session.threadId) return;
          if (message.method === "turn/started" || message.method === "turn/completed") {
            if (message.method === "turn/started") session.turnId = params.turn?.id;
            else if (params.turn?.id === session.turnId) {
              session.turnId = undefined;
              void cancelDelegation().catch(() => {});
            }
            send({ method: message.method, params: { threadId: session.threadId, turn: { id: params.turn?.id } } });
          } else if (["thread/realtime/sdp", "thread/realtime/error", "thread/realtime/closed", "thread/realtime/started",
            "thread/realtime/transcript/done", "thread/realtime/item/started", "thread/realtime/item/completed"].includes(message.method)) send(message);
        });
        const account = await session.rpc.request("account/read", { refreshToken: false }, session.abort.signal);
        checkAccount(account);
        let threadModel = model;
        if (session.gateway && !threadModel) {
          const catalog = await session.rpc.request("model/list", { limit: 50, includeHidden: false }, session.abort.signal);
          const preferred = catalog.data?.find(item => item.isDefault) ?? catalog.data?.[0];
          threadModel = preferred?.model ?? preferred?.id;
          if (typeof threadModel !== "string" || !threadModel) {
            throw new Error("현재 ChatGPT 계정에서 업무 위임용 Codex 모델을 찾지 못했습니다.");
          }
        }
        const result = await session.rpc.request("thread/start", {
          cwd, sandbox: "read-only", approvalPolicy: "on-request", ephemeral: true,
          model: threadModel,
          config: { "features.realtime_conversation": true, "realtime.type": "conversational" },
          developerInstructions: codexVoiceInstructions,
          ...(session.gateway ? { dynamicTools: [OPENCLAW_MAIN_TOOL] } : {}),
        }, session.abort.signal);
        if (!result.thread?.id) throw new Error("Codex did not allocate a voice thread.");
        session.threadId = result.thread.id;
        return { threadId: session.threadId, mode: "read-only" };
      })();
      return session.opening;
    };
    const stopRealtime = async () => {
      await session.starting?.catch(() => {});
      if (session.realtime && session.rpc && session.threadId) {
        session.realtime = false;
        await session.rpc.request("thread/realtime/stop", { threadId: session.threadId });
      }
    };
    const close = (disconnected = false) => {
      if (session.closing) return session.closing;
      session.closing = Promise.resolve().then(async () => {
        try {
          await session.opening?.catch(() => {});
          const cancelled = cancelDelegation().catch(() => {});
          await stopRealtime().catch(() => {});
          await cancelled;
          const gateway = await session.gatewaySession?.catch(() => undefined);
          await gateway?.close();
        } finally {
          if (session.rpc && session.threadId) await session.rpc.request("thread/unsubscribe", { threadId: session.threadId }).catch(() => {});
          session.abort.abort();
          try { await session.rpc?.close(); }
          finally { if (active === session) active = undefined; }
        }
      });
      if (disconnected) session.abort.abort(new Error("Voice browser disconnected."));
      return session.closing;
    };
    session.stop = close;
    async function handle(method, params) {
      if (session.closing) throw new Error("Codex voice session is closing.");
      if (method === "voice/open") return open();
      if (method === "voice/close") { await close(!session.threadId); return {}; }
      ensureThread(params);
      if (method === "thread/realtime/start") {
        if (session.realtime || params.transport?.type !== "webrtc" || typeof params.transport.sdp !== "string" ||
          params.transport.sdp.length > 120000) throw new Error("Invalid or duplicate Codex voice start.");
        session.realtime = true;
        session.starting = session.rpc.request(method, { threadId: session.threadId,
          transport: { type: "webrtc", sdp: params.transport.sdp }, version: "v3", outputModality: "audio", clientManagedHandoffs: false,
          ...(voiceModel ? { model: voiceModel } : {}),
          delegationAckFiller: false,
          initialItems: [{ role: "developer", text: codexVoiceInstructions }],
          realtimeStartInstructions: codexVoiceInstructions,
        });
        return session.starting;
      }
      if (method === "thread/realtime/stop") {
        try { await cancelDelegation(); }
        finally { await stopRealtime(); }
        return {};
      }
      if (method === "voice/interrupt") {
        await Promise.all([
          cancelDelegation(),
          session.turnId ? session.rpc.request("turn/interrupt", { threadId: session.threadId, turnId: session.turnId }) : undefined,
        ]);
        return {};
      }
      throw new Error("This method is outside the Codex voice bridge contract.");
    }
    client.on("message", (data, binary) => {
      let message;
      try {
        message = JSON.parse(data.toString());
        if (binary || !Number.isSafeInteger(message.id) || message.id < 1 || typeof message.method !== "string" ||
          !message.params || typeof message.params !== "object" || Array.isArray(message.params) ||
          session.pending.has(message.id) || session.pending.size >= 16) throw new Error("Invalid voice request.");
      } catch { client.close(1008, "Invalid voice request"); return; }
      session.pending.add(message.id);
      void handle(message.method, message.params).then(
        (result) => send({ id: message.id, result }),
        (error) => send({ id: message.id, error: { code: -32000, message: text(error.message) } }),
      ).finally(() => session.pending.delete(message.id));
    });
    client.on("error", () => { void close(true); });
    client.on("close", () => { void close(true); });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  url = `http://127.0.0.1:${server.address().port}`;
  return { url, inspect, get busy() { return !!active; },
    async close() {
      if (active) await active.stop(true).catch(() => {});
      for (const client of websocket.clients) client.terminate();
      await new Promise((resolve) => websocket.close(resolve));
      await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    },
  };
}
