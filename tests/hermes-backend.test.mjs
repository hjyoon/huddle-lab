import assert from "node:assert/strict";
import { test } from "node:test";
import { createHermesBackend, validateHermesSettings, spokenText, hermesSpokenReplyInstructions } from "../scripts/hermes-backend.mjs";

const settings = { url: "http://127.0.0.1:8642", apiKey: "never-echo-this-key" };
const speech = { async inspectSpeech() { return { speechReady: true, stt: "test", tts: "test" }; },
  async transcribe() { return "test"; }, async synthesize() { return new Float32Array(960); } };
const json = (status, value) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

/** A fake Hermes Runs API. `script.run(id, polls)` returns the status body for each poll. */
function fakeHermes({ capabilities = { model: "hermes-agent", features: { run_submission: true, run_status: true, run_stop: true } },
  statusFor = () => ({ status: "completed", output: "안녕하세요." }), onSubmit, onStop } = {}) {
  const calls = [];
  const runs = new Map();
  let next = 0;
  const fetch = async (url, init = {}) => {
    const { pathname } = new URL(url);
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, pathname, body, headers: init.headers });
    assert.equal(init.headers.Authorization, `Bearer ${settings.apiKey}`);
    init.signal?.throwIfAborted();
    if (pathname === "/v1/capabilities") return json(200, capabilities);
    if (pathname === "/v1/runs" && method === "POST") {
      const replay = [...runs.values()].find(run => run.key === init.headers["Idempotency-Key"]);
      if (replay) return json(202, { run_id: replay.id, status: "started" });
      const extra = await onSubmit?.(body, calls);
      if (extra instanceof Response) return extra;
      const id = `run_${++next}`;
      runs.set(id, { id, key: init.headers["Idempotency-Key"], polls: 0, stopped: false, body });
      return json(202, { run_id: id, status: "started" });
    }
    const match = pathname.match(/^\/v1\/runs\/([^/]+)(\/stop)?$/);
    const run = match && runs.get(decodeURIComponent(match[1]));
    if (!run) return json(404, { error: "not found" });
    if (match[2]) { run.stopped = true; const extra = await onStop?.(run); return extra ?? json(200, { run_id: run.id, status: "stopping" }); }
    run.polls++;
    return json(200, { run_id: run.id, ...statusFor(run) });
  };
  return { fetch, calls, runs };
}

test("settings accept https or a loopback tunnel and refuse credentials in the URL", () => {
  assert.deepEqual(validateHermesSettings({ url: "http://127.0.0.1:8642/v1/", apiKey: "k" }), { url: "http://127.0.0.1:8642", apiKey: "k" });
  assert.equal(validateHermesSettings({ url: "https://hermes.example/", apiKey: "k" }).url, "https://hermes.example");
  for (const url of ["http://hermes.example", "https://user:pass@hermes.example", "https://hermes.example/?key=1", "ftp://127.0.0.1"]) {
    assert.throws(() => validateHermesSettings({ url, apiKey: "k" }));
  }
  assert.throws(() => validateHermesSettings({ url: "https://hermes.example", apiKey: "" }), /API_SERVER_KEY/);
  assert.throws(() => validateHermesSettings({ url: "https://hermes.example", apiKey: "a b" }));
});

test("readiness checks the Runs API capabilities and local speech, without leaking the key", async () => {
  const hermes = fakeHermes();
  const backend = createHermesBackend({ settings, speech, fetch: hermes.fetch });
  const status = await backend.inspect();
  assert.equal(status.ready, true);
  assert.equal(status.modelName, "hermes-agent");
  assert.equal(JSON.stringify(status).includes(settings.apiKey), false);

  const old = createHermesBackend({ settings, speech, fetch: fakeHermes({ capabilities: { features: { run_submission: true } } }).fetch });
  assert.match((await old.inspect()).error, /실행 취소를 지원하지 않습니다/);

  const unconfigured = createHermesBackend({ speech, fetch: hermes.fetch });
  assert.match((await unconfigured.inspect()).error, /HUDDLE_HERMES_URL/);

  const rejected = createHermesBackend({ settings, speech, fetch: async () => json(401, { error: { message: settings.apiKey } }) });
  const failure = await rejected.inspect();
  assert.match(failure.error, /API_SERVER_KEY/);
  assert.equal(JSON.stringify(failure).includes(settings.apiKey), false);
});

test("one Hermes session per call, one run per utterance, spoken instructions attached", async () => {
  const hermes = fakeHermes({ statusFor: run => run.polls < 3 ? { status: "running" } : { status: "completed", output: `**답변 ${run.id}**` } });
  const backend = createHermesBackend({ settings, speech, fetch: hermes.fetch, pollMs: 1 });
  const call = await backend.openSession();
  const first = await call.reply([{ role: "user", content: "첫 질문" }], new AbortController().signal);
  const second = await call.reply([{ role: "user", content: "첫 질문" }, { role: "assistant", content: first }, { role: "user", content: "두 번째" }], new AbortController().signal);
  assert.equal(first, "답변 run_1");
  assert.equal(second, "답변 run_2");
  const submits = hermes.calls.filter(c => c.pathname === "/v1/runs");
  assert.equal(submits.length, 2);
  assert.equal(submits[0].body.session_id, submits[1].body.session_id);
  assert.match(submits[0].body.session_id, /^huddle-/);
  assert.deepEqual(submits.map(c => c.body.input), ["첫 질문", "두 번째"]);
  assert.equal(submits[0].body.instructions, hermesSpokenReplyInstructions);
  assert.notEqual(submits[0].headers["Idempotency-Key"], submits[1].headers["Idempotency-Key"]);
  const other = await backend.openSession();
  assert.notEqual(other.sessionId, call.sessionId);
});

test("barge-in stops exactly the current run and waits for a terminal status", async () => {
  const hermes = fakeHermes({ statusFor: run => run.stopped ? { status: "cancelled" } : { status: "running" } });
  const backend = createHermesBackend({ settings, speech, fetch: hermes.fetch, pollMs: 1 });
  const call = await backend.openSession();
  const abort = new AbortController();
  const pending = call.reply([{ role: "user", content: "길게 말해 줘" }], abort.signal);
  while (!hermes.runs.get("run_1")?.polls) await new Promise(r => setTimeout(r, 1));
  abort.abort(new Error("Voice response interrupted."));
  await assert.rejects(pending, /Voice response interrupted/);
  const stops = hermes.calls.filter(c => c.pathname.endsWith("/stop"));
  assert.deepEqual(stops.map(c => c.pathname), ["/v1/runs/run_1/stop"]);
  const last = hermes.calls.at(-1);
  assert.equal(last.pathname, "/v1/runs/run_1");
  // A confirmed stop does not block the backend.
  assert.equal((await backend.inspect()).ready, true);
});

test("an interrupt during submission still learns the run ID and stops it", async () => {
  const abort = new AbortController();
  const hermes = fakeHermes({ onSubmit: () => { abort.abort(new Error("interrupted while submitting")); },
    statusFor: run => run.stopped ? { status: "cancelled" } : { status: "running" } });
  const backend = createHermesBackend({ settings, speech, fetch: hermes.fetch, pollMs: 1 });
  const call = await backend.openSession();
  await assert.rejects(call.reply([{ role: "user", content: "질문" }], abort.signal), /interrupted while submitting/);
  assert.ok(hermes.calls.some(c => c.pathname === "/v1/runs/run_1/stop"));
});

test("an unconfirmed stop blocks further requests and is fatal for the session", async () => {
  const hermes = fakeHermes({ statusFor: () => ({ status: "running" }) });
  const backend = createHermesBackend({ settings, speech, fetch: hermes.fetch, pollMs: 1, stopTimeoutMs: 20 });
  const call = await backend.openSession();
  const abort = new AbortController();
  const pending = call.reply([{ role: "user", content: "질문" }], abort.signal);
  while (!hermes.runs.get("run_1")?.polls) await new Promise(r => setTimeout(r, 1));
  abort.abort(new Error("interrupt"));
  const error = await pending.catch(e => e);
  assert.equal(error.fatal, true);
  assert.match(error.message, /종료를 확인하지 못했습니다/);
  await assert.rejects(call.reply([{ role: "user", content: "또" }]), /종료를 확인하지 못했습니다/);
  assert.equal((await backend.inspect()).ready, false);
});

test("a lost submission response is retried with the same idempotency key, never a new run", async () => {
  let drop = true;
  const hermes = fakeHermes();
  const fetch = async (url, init) => {
    const response = await hermes.fetch(url, init);
    if (drop && new URL(url).pathname === "/v1/runs") { drop = false; throw new TypeError("fetch failed"); }
    return response;
  };
  const backend = createHermesBackend({ settings, speech, fetch, pollMs: 1 });
  const answer = await (await backend.openSession()).reply([{ role: "user", content: "질문" }]);
  assert.equal(answer, "안녕하세요.");
  assert.equal(hermes.runs.size, 1);
  const keys = hermes.calls.filter(c => c.pathname === "/v1/runs").map(c => c.headers["Idempotency-Key"]);
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1]);
});

test("an unknown admission blocks the session instead of risking a duplicate run", async () => {
  const backend = createHermesBackend({ settings, speech, pollMs: 1, fetch: async (url, init) => {
    if (new URL(url).pathname === "/v1/runs") throw new TypeError("fetch failed");
    return fakeHermes().fetch(url, init);
  } });
  const error = await (await backend.openSession()).reply([{ role: "user", content: "질문" }]).catch(e => e);
  assert.equal(error.fatal, true);
  assert.match(error.message, /접수 여부/);
});

test("HTTP rejections are reported without echoing server bodies and do not block the call", async () => {
  const hermes = fakeHermes({ onSubmit: () => json(429, { error: { message: settings.apiKey } }) });
  const backend = createHermesBackend({ settings, speech, fetch: hermes.fetch, pollMs: 1 });
  const call = await backend.openSession();
  const error = await call.reply([{ role: "user", content: "질문" }]).catch(e => e);
  assert.notEqual(error.fatal, true);
  assert.match(error.message, /요청을 제한/);
  assert.equal(error.message.includes(settings.apiKey), false);
  assert.equal((await backend.inspect()).ready, true);
});

test("failed and cancelled runs and empty output become errors", async () => {
  for (const [state, pattern] of [[{ status: "failed" }, /실패/], [{ status: "interrupted" }, /중단/], [{ status: "completed", output: "  " }, /답변이 없습니다/]]) {
    const backend = createHermesBackend({ settings, speech, fetch: fakeHermes({ statusFor: () => state }).fetch, pollMs: 1 });
    await assert.rejects((await backend.openSession()).reply([{ role: "user", content: "질문" }]), pattern);
  }
});

test("a run waiting for approval is stopped instead of hanging the call", async () => {
  const hermes = fakeHermes({ statusFor: run => run.stopped ? { status: "cancelled" } : { status: "waiting_for_approval" } });
  const backend = createHermesBackend({ settings, speech, fetch: hermes.fetch, pollMs: 1 });
  const error = await (await backend.openSession()).reply([{ role: "user", content: "서버 재시작해 줘" }]).catch(e => e);
  assert.match(error.message, /승인이 필요한 작업/);
  assert.notEqual(error.fatal, true);
  assert.ok(hermes.calls.some(c => c.pathname === "/v1/runs/run_1/stop"));
});

test("an already cancelled turn sends nothing", async () => {
  const hermes = fakeHermes();
  const backend = createHermesBackend({ settings, speech, fetch: hermes.fetch });
  const abort = new AbortController();
  abort.abort(new Error("cancelled before launch"));
  await assert.rejects((await backend.openSession()).reply([{ role: "user", content: "질문" }], abort.signal), /cancelled before launch/);
  assert.equal(hermes.calls.length, 0);
});

test("spoken text drops Markdown and stays within the speech limit", () => {
  assert.equal(spokenText("## 제목\n- **굵게** 항목\n`code` [링크](https://x.example) https://y.example"), "제목\n굵게 항목\ncode 링크");
  const long = "가".repeat(700) + "요. " + "나".repeat(900);
  const result = spokenText(long);
  assert.ok(result.length <= 1200);
  assert.ok(result.endsWith("요."));
});
