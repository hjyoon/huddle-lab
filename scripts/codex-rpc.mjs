// JSONL owner adapted from Buzz v1.0.4 bundled/codex/rpc.ts.
// Copyright 2026 Block, Inc. Apache-2.0; see LICENSE and NOTICE.
// Modified: Node child process, private logs, abortable host requests.
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, isAbsolute } from "node:path";

export async function openCodexRpc({ cwd, runtimeRoot, binary = "codex", signal, handleToolCall, spawnProcess = spawn }) {
  if (!isAbsolute(cwd) || !isAbsolute(runtimeRoot)) throw new Error("Codex workspace and runtime paths must be absolute.");
  signal?.throwIfAborted();
  await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
  const runtime = await mkdtemp(join(runtimeRoot, "session-"));
  const child = spawnProcess(binary, ["app-server", "--stdio",
    "-c", `log_dir=${JSON.stringify(join(runtime, "logs"))}`,
  ], { cwd, stdio: ["pipe", "pipe", "pipe"], shell: false, detached: process.platform !== "win32" });
  let next = 0, buffer = "", failure, closing;
  const pending = new Map(), listeners = new Set();
  const exited = new Promise((resolve) => {
    child.once("error", resolve);
    child.once("exit", resolve);
  });
  function fail(error) {
    if (failure) return;
    failure = error;
    for (const item of pending.values()) { clearTimeout(item.timer); item.off(); item.reject(error); }
    pending.clear();
    for (const listener of listeners) listener({ method: "connection/closed", params: { message: error.message } });
  }
  child.on("error", () => fail(new Error("Could not start the installed Codex CLI.")));
  child.on("exit", (code) => fail(new Error(`Codex app-server exited (${code ?? "signal"}).`)));
  // Do not forward stderr/config/auth to a browser or logs owned by this bridge.
  child.stderr.resume();
  const send = (value) => new Promise((resolve, reject) => {
    if (failure) { reject(failure); return; }
    child.stdin.write(`${JSON.stringify(value)}\n`, (error) => error ? reject(error) : resolve());
  });
  child.stdin.on("error", () => fail(new Error("Codex input connection closed.")));
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (data) => {
    try {
      buffer += data;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        if (newline > 4 * 1024 * 1024) throw new Error("Codex JSONL frame exceeded the limit.");
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        const value = JSON.parse(line);
        if (value.id !== undefined && value.method) {
          if (value.method === "item/tool/call" && handleToolCall) {
            void Promise.resolve().then(() => handleToolCall(value.params)).then(
              result => send({ id: value.id, result }),
              () => send({ id: value.id, error: { code: -32603, message: "Voice delegation failed." } }),
            ).catch(fail);
          } else {
            void send({ id: value.id, error: { code: -32601, message: "Interactive requests are unsupported by this voice host." } }).catch(fail);
          }
        } else if (value.id !== undefined) {
          const item = pending.get(value.id);
          if (!item) continue;
          pending.delete(value.id); clearTimeout(item.timer); item.off();
          if (value.error) item.reject(new Error(String(value.error.message ?? "Codex request refused").slice(0, 1000)));
          else item.resolve(value.result);
        } else for (const listener of listeners) listener(value);
      }
      if (buffer.length > 4 * 1024 * 1024) throw new Error("Codex JSONL frame exceeded the limit.");
    } catch (error) { fail(error); void close(); }
  });
  function request(method, params = {}, requestSignal) {
    if (failure) return Promise.reject(failure);
    requestSignal?.throwIfAborted();
    if (pending.size >= 32) return Promise.reject(new Error("Codex request queue is full."));
    const id = ++next;
    return new Promise((resolve, reject) => {
      const cancel = (error) => {
        const item = pending.get(id);
        if (!item) return;
        pending.delete(id); clearTimeout(item.timer); item.off(); reject(error);
      };
      const onAbort = () => cancel(requestSignal.reason);
      const timer = setTimeout(() => cancel(new Error(`Codex ${method} timed out.`)), 30000);
      pending.set(id, { resolve, reject, timer, off: () => requestSignal?.removeEventListener("abort", onAbort) });
      requestSignal?.addEventListener("abort", onAbort, { once: true });
      void send({ id, method, params }).catch(cancel);
    });
  }
  function close() {
    if (closing) return closing;
    signal?.removeEventListener("abort", onAbort);
    closing = Promise.resolve().then(async () => {
      child.stdin.end();
      const killOwned = (signal) => {
        try {
          if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
          else child.kill(signal);
        } catch { /* Already exited. */ }
      };
      const terminate = setTimeout(() => killOwned("SIGTERM"), 3000);
      const kill = setTimeout(() => killOwned("SIGKILL"), 5000);
      try { await exited; }
      finally { clearTimeout(terminate); clearTimeout(kill); await rm(runtime, { recursive: true, force: true }); }
    });
    fail(new Error("Codex connection closed."));
    return closing;
  }
  const onAbort = () => { void close(); };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    signal?.throwIfAborted();
    const initialized = await request("initialize", {
      clientInfo: { name: "huddle_lab", title: "AI Huddle Lab", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    }, signal);
    await send({ method: "initialized" });
    return { initialized, request, close,
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    };
  } catch (error) { await close(); throw error; }
}
