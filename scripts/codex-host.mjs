import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve, isAbsolute } from "node:path";
import { stat } from "node:fs/promises";
import { WebSocketServer } from "ws";
import { openCodexRpc } from "./codex-rpc.mjs";
import { serveDemoFile } from "./serve-demo.mjs";

const run = promisify(execFile);
const text = (value) => String(value ?? "Codex request failed").replace(/[\x00-\x1f]/g, " ").slice(0, 1000);
export async function createCodexHost({ port = 4182, cwd = process.cwd(), binary = "codex",
  runtimeRoot = resolve(cwd, ".huddle-runtime/codex"), createRpc = openCodexRpc } = {}) {
  if (!isAbsolute(cwd) || !(await stat(cwd)).isDirectory()) throw new Error("Choose an existing absolute Codex workspace.");
  let url, active, status, checking;
  const makeRpc = (signal) => createRpc({ cwd, runtimeRoot, binary, signal });
  async function inspect() {
    if (checking) return checking;
    checking = (async () => {
      let rpc;
      try {
        const version = createRpc === openCodexRpc ? (await run(binary, ["--version"], { cwd, timeout: 5000 })).stdout.trim() : "protocol fixture";
        rpc = await makeRpc();
        const account = await rpc.request("account/read", { refreshToken: false });
        status = { installed: true, signedIn: !!account.account, ready: !!account.account || account.requiresOpenaiAuth === false,
          version: text(version), workspace: cwd, mode: "read-only" };
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
    if (request.headers.host !== new URL(url).host || request.headers.origin !== url || request.url !== "/codex" || active) {
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
    const open = () => {
      if (session.opening) return session.opening;
      session.opening = (async () => {
        session.rpc = await makeRpc(session.abort.signal);
        session.rpc.subscribe((message) => {
          const params = message.params ?? {};
          if (message.method === "connection/closed") { send({ method: "connection/closed", params: { message: "Codex app-server disconnected." } }); return; }
          if (params.threadId !== session.threadId) return;
          if (message.method === "turn/started" || message.method === "turn/completed") {
            session.turnId = message.method === "turn/started" ? params.turn?.id : undefined;
            send({ method: message.method, params: { threadId: session.threadId, turn: { id: params.turn?.id } } });
          } else if (["thread/realtime/sdp", "thread/realtime/error", "thread/realtime/closed", "thread/realtime/started",
            "thread/realtime/transcript/done", "thread/realtime/item/started", "thread/realtime/item/completed"].includes(message.method)) send(message);
        });
        const account = await session.rpc.request("account/read", { refreshToken: false }, session.abort.signal);
        if (!account.account && account.requiresOpenaiAuth !== false) throw new Error("Sign in using codex login before starting voice.");
        const result = await session.rpc.request("thread/start", {
          cwd, sandbox: "read-only", approvalPolicy: "on-request", ephemeral: true,
          config: { "features.realtime_conversation": true, "realtime.type": "conversational" },
          developerInstructions: "This is a local Korean voice conversation. Keep spoken replies concise. The workspace is read-only. Follow the user's spoken requests and the existing tool permission policy.",
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
      if (disconnected) session.abort.abort(new Error("Voice browser disconnected."));
      session.closing = Promise.resolve().then(async () => {
        try {
          await session.opening?.catch(() => {});
          await stopRealtime().catch(() => {});
          if (session.rpc && session.threadId) await session.rpc.request("thread/unsubscribe", { threadId: session.threadId }).catch(() => {});
        } finally {
          session.abort.abort();
          try { await session.rpc?.close(); }
          finally { if (active === session) active = undefined; }
        }
      });
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
          realtimeStartInstructions: "Speak Korean unless asked otherwise. Answer naturally and briefly. Delegate code questions to Codex; never claim results before they return.",
        });
        return session.starting;
      }
      if (method === "thread/realtime/stop") { await stopRealtime(); return {}; }
      if (method === "voice/interrupt") {
        if (session.turnId) await session.rpc.request("turn/interrupt", { threadId: session.threadId, turnId: session.turnId });
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
  return { url, inspect,
    async close() {
      if (active) await active.stop(true).catch(() => {});
      for (const client of websocket.clients) client.terminate();
      await new Promise((resolve) => websocket.close(resolve));
      await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    },
  };
}
