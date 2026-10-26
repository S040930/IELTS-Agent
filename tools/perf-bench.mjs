// Core interaction latency probe for PERF-01.
// Usage: node tools/perf-bench.mjs [baseUrl] [rounds]
// Exercises the same API sequence the web client uses for common paths and
// prints per-request wall time and response size. Mutating calls run once on a
// throwaway attempt; point it at a disposable data directory.
const base = (process.argv[2] ?? "http://127.0.0.1:4180").replace(/\/$/, "");
const rounds = Number(process.argv[3] ?? 3);

const rows = [];

async function call(label, path, init, { repeat = 1 } = {}) {
  const samples = [];
  let bytes = 0;
  let status = 0;
  let body;
  for (let index = 0; index < repeat; index += 1) {
    const started = performance.now();
    const response = await fetch(base + path, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    });
    const text = await response.text();
    const total = performance.now() - started;
    status = response.status;
    bytes = text.length;
    samples.push(total);
    try { body = JSON.parse(text); } catch { body = undefined; }
    if (!response.ok) throw new Error(`${label} ${path} -> ${response.status} ${text.slice(0, 200)}`);
  }
  const best = Math.min(...samples);
  const avg = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  rows.push({ label, path, status, best, avg, bytes, n: samples.length });
  return body;
}

const fmt = (value) => `${value.toFixed(1)}ms`;
const kb = (value) => value >= 1024 * 1024 ? `${(value / 1048576).toFixed(2)}MB` : `${(value / 1024).toFixed(0)}KB`;

const boot = await call("auth session", "/api/auth/session", undefined, { repeat: rounds });
console.log("authenticated:", boot?.authenticated);
const data = await call("bootstrap", "/api/bootstrap", undefined, { repeat: rounds });
console.log("catalog:", data.activities.length, "activities", data.activities.reduce((sum, item) => sum + (item.questionCount ?? 0), 0), "questions");
await call("bootstrap (repeat)", "/api/bootstrap", undefined, { repeat: rounds });
await call("plan status", "/api/plan-proposals/status", undefined, { repeat: rounds });
await call("mock availability", "/api/mock/available", undefined, { repeat: rounds });

const reading = data.activities.find((item) => item.pluginId === "reading" && item.questionCount >= 5);
const listening = data.activities.find((item) => item.pluginId === "listening" && item.questionCount >= 5);
if (!reading) throw new Error("no reading activity in catalog");

const started = await call("start practice", "/api/attempts", { method: "POST", body: JSON.stringify({ activityId: reading.id, mode: "practice" }) });
const attemptId = started.draft.attemptId;
const answers = Object.fromEntries(started.activity.questions.slice(0, 3).map((question, index) => [question.id, `answer-${index + 1}`]));
await call("save draft", `/api/attempts/${attemptId}/draft`, {
  method: "PATCH",
  body: JSON.stringify({ answers, questionTimeSeconds: Object.fromEntries(Object.keys(answers).map((id) => [id, 12])), revision: Date.now() }),
});
await call("resume draft", `/api/attempts/${attemptId}`, undefined, { repeat: rounds });
await call("coach history", `/api/coach/history?conversationId=perf-${Date.now()}`, undefined, { repeat: rounds });
await call("submit", `/api/attempts/${attemptId}/submit`, {
  method: "POST",
  body: JSON.stringify({ answers, questionTimeSeconds: Object.fromEntries(Object.keys(answers).map((id) => [id, 12])) }),
});
await call("review attempt", `/api/attempts/${attemptId}`, undefined, { repeat: rounds });
await call("bootstrap after submit", "/api/bootstrap", undefined, { repeat: rounds });

if (listening) {
  const mock = await call("mock prepare", "/api/mock/prepare", { method: "POST", body: JSON.stringify({ section: "listening" }) });
  if (mock?.activity?.mockId) {
    const startedMock = await call("mock start", "/api/mock/start", {
      method: "POST",
      body: JSON.stringify({ section: "listening", mockId: mock.activity.mockId, audioDurationsSeconds: [180, 180, 180, 180] }),
    });
    const mockId = startedMock.draft.attemptId;
    const mockAnswers = Object.fromEntries(startedMock.activity.questions.map((question) => [question.id, "x"]));
    await call("mock submit", `/api/attempts/${mockId}/submit`, { method: "POST", body: JSON.stringify({ answers: mockAnswers }) });
    await call("listening transcript", `/api/attempts/${mockId}/transcript`, undefined, { repeat: 1 });
    await call("listening analysis", `/api/attempts/${mockId}/analysis`, undefined, { repeat: 1 });
  }
}

console.log("");
console.log(["step", "status", "best", "avg", "response"].join("\t"));
for (const row of rows) console.log([row.label, row.status, fmt(row.best), fmt(row.avg), kb(row.bytes)].join("\t"));
