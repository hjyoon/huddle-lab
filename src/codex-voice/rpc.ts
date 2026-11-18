import { isVoiceWebSocket } from "../voice-websocket.js";

export type CodexNotification = { method: string; params?: Record<string, unknown> };
export type CodexVoiceSession = {
  threadId: string;
  request(method: string, params?: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  subscribe(listener: (message: CodexNotification) => void): () => void;
  close(): Promise<void>;
};

export function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void operation.catch(() => {}); return Promise.reject(signal.reason); }
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** The companion host owns a fresh Codex thread and validates the limited RPC
 * surface. Authentication tokens never cross this local browser connection. */
export function createCodexLocalConnector(url: string) {
  const target = new URL(url);
  if (!isVoiceWebSocket(target)) throw new Error("The Codex companion must use a loopback or same-origin secure WebSocket URL.");
  return async (signal: AbortSignal): Promise<CodexVoiceSession> => {
    signal.throwIfAborted();
    const socket = new WebSocket(target);
    let next = 0, failure: Error | undefined, closing: Promise<void> | undefined;
    const listeners = new Set<(message: CodexNotification) => void>();
    const pending = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void; timer: ReturnType<typeof setTimeout> }>();
    const fail = (error: Error) => {
      if (failure) return;
      failure = error;
      for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
      pending.clear();
      for (const listener of listeners) listener({ method: "connection/closed", params: { message: error.message } });
    };
    socket.addEventListener("message", (event) => {
      try {
        if (typeof event.data !== "string" || event.data.length > 512 * 1024) throw new Error("Invalid local Codex frame.");
        const value = JSON.parse(event.data);
        if (typeof value.id === "number" && !value.method) {
          const item = pending.get(value.id);
          if (!item) return;
          pending.delete(value.id); clearTimeout(item.timer);
          if (value.error) item.reject(new Error(String(value.error.message).slice(0, 1000)));
          else item.resolve(value.result);
        } else if (typeof value.method === "string") for (const listener of listeners) listener(value);
      } catch (error) { fail(error as Error); socket.close(); }
    });
    socket.addEventListener("close", () => fail(new Error("Local Codex connection closed.")));
    socket.addEventListener("error", () => fail(new Error("Could not connect to the local Codex companion.")));
    const request = async (method: string, params: Record<string, unknown> = {}, requestSignal?: AbortSignal) => {
      if (failure) throw failure;
      requestSignal?.throwIfAborted();
      if (socket.readyState !== WebSocket.OPEN || pending.size >= 16) throw new Error("Local Codex connection is unavailable or busy.");
      const id = ++next;
      const operation = new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Codex ${method} timed out.`)); }, 30000);
        pending.set(id, { resolve, reject, timer });
        try { socket.send(JSON.stringify({ id, method, params })); }
        catch (error) { pending.delete(id); clearTimeout(timer); reject(error); }
      });
      return requestSignal ? abortable(operation, requestSignal) : operation;
    };
    const close = () => {
      if (closing) return closing;
      signal.removeEventListener("abort", onAbort);
      closing = Promise.resolve().then(async () => {
        try { if (!failure && socket.readyState === WebSocket.OPEN) await request("voice/close"); }
        finally { fail(new Error("Local Codex session closed.")); socket.close(); listeners.clear(); }
      });
      return closing;
    };
    const onAbort = () => { void close().catch(() => {}); };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      await abortable(new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener("error", () => reject(new Error("Could not connect to the local Codex companion.")), { once: true });
        socket.addEventListener("close", () => reject(new Error("Local Codex connection closed during startup.")), { once: true });
      }), AbortSignal.any([signal, AbortSignal.timeout(10000)]));
      const result = await request("voice/open", {}, signal) as { threadId?: unknown };
      if (typeof result.threadId !== "string" || !result.threadId) throw new Error("Codex did not allocate a voice thread.");
      return { threadId: result.threadId, request, close,
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      };
    } catch (error) { await close().catch(() => {}); throw error; }
  };
}
