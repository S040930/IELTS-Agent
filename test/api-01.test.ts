import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { BootstrapData, PlanProposal, PlanTask } from "../src/shared/domain.js";
import { LearningStore } from "../server/db.js";
import { PostgresLearningStore } from "../server/postgres-store.js";
import { createApp } from "../server/index.js";
import { errorResponse } from "../server/http-error.js";
import { AiClient, type AiMessage } from "../server/services/ai-client.js";
import { validatePlan, type PlanningInput } from "../server/services/ai-planner.js";
import { planningPayload } from "../server/services/planning-payload.js";
import { buildPlanningUnits } from "../server/services/planning-units.js";
import { goalFormReducer, type GoalFormState } from "../src/services/goal-form.js";
import { startPlanPolling } from "../src/services/plan-polling.js";
import { api, ApiError } from "../src/services/api.js";

type App = Awaited<ReturnType<typeof createApp>>;
async function dispatch(app: App, method: string, url: string, payload?: unknown) {
  let status = 200, text = "";
  const req = { method, url, headers: { host: "localhost" },
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(payload ?? {})); },
  } as unknown as IncomingMessage;
  const res = { writeHead(value: number) { status = value; }, end(value: string) { text = value; } } as unknown as ServerResponse;
  try { await app.handle(req, res); }
  catch (reason) { const result = errorResponse(reason); status = result.status; text = JSON.stringify(result.body); }
  return { status, body: JSON.parse(text) as BootstrapData & { proposal: PlanProposal; error: string; applied?: boolean } };
}
const goals = { targetListening: 7, targetReading: 7, dailyMinutes: 180, examDate: "2026-12-31" };
function reply(messages: AiMessage[]): string {
  const input = JSON.parse(messages[1]!.content) as PlanningInput;
  const sections = input.requiredBaselineSections.length ? input.requiredBaselineSections : [...new Set(input.units.map((unit) => unit.pluginId))];
  return JSON.stringify({ tasks: sections.map((section) => ({
    unitId: input.units.find((unit) => unit.pluginId === section)!.id, reason: "建立基线并观察独立表现。",
  })) });
}
async function fixture(run: (app: App, store: LearningStore, ai: AiClient) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "ielts-api01-"));
  const store = new LearningStore(join(directory, "test.sqlite"));
  const ai = new AiClient(); ai.complete = async (messages) => reply(messages);
  let app: App | undefined;
  try {
    app = await createApp({ store, activities: [], aiClient: ai, deferStartupPlanning: true });
    await run(app, store, ai);
  } finally {
    if (app) await app.close(); else store.close();
    await rm(directory, { recursive: true, force: true });
  }
}
function task(store: LearningStore, id: string, extra: Partial<PlanTask> = {}): PlanTask {
  return { id, date: store.today(), activityId: "reading-seed", pluginId: "reading", kind: "practice",
    title: "练习", description: "练习", minutes: 10, reason: "观察表现", questionIds: [id + "-q"],
    locked: false, status: "pending", ...extra };
}

describe("API-01 request paths", () => {
  it("accepts real service DTOs through the client and sends exactly one request per goal save", async () => fixture(async (app) => {
    const previous = globalThis.fetch;
    const requests: string[] = [];
    try {
      globalThis.fetch = async (url, init) => {
        const method = init?.method ?? "GET";
        requests.push(method + " " + String(url));
        const result = await dispatch(app, method, String(url), init?.body ? JSON.parse(String(init.body)) : undefined);
        return new Response(JSON.stringify(result.body), { status: result.status });
      };
      const saved = await api.setProfile({ ...goals, setupComplete: true });
      assert.equal(saved.profile.setupComplete, true);
      assert.deepEqual(requests, ["PUT /api/profile"]);
      await app.waitForBackgroundJobs();
      const boot = await api.bootstrap();
      assert.equal(boot.planProposal.status, "ready");
      const confirmed = await api.confirmPlanProposal(boot.planProposal.id!);
      assert.equal(confirmed.planProposal.status, "confirmed");
      assert.ok(confirmed.plan.length > 0);
    } finally { globalThis.fetch = previous; }
  }));

  it("saves goals through one dispatch, computes one planning input and keeps a confirmed day fixed", async () => fixture(async (app, store, ai) => {
    let modelCalls = 0, evidenceCalls = 0;
    ai.complete = async (messages) => { modelCalls++; return reply(messages); };
    const evidence = store.evidence.bind(store);
    store.evidence = () => { evidenceCalls++; return evidence(); };
    const saved = await dispatch(app, "PUT", "/api/profile", goals);
    assert.equal(saved.status, 200);
    await app.waitForBackgroundJobs();
    assert.equal(modelCalls, 1);
    assert.equal(evidenceCalls, 2); // one planning input and one bootstrap DTO
    const proposal = store.planProposal();
    const confirmed = await dispatch(app, "POST", "/api/plan-proposals/" + proposal.id + "/confirm");
    assert.equal(confirmed.status, 200);
    const plan = store.plan();
    evidenceCalls = 0;
    await dispatch(app, "GET", "/api/bootstrap");
    assert.equal(evidenceCalls, 1); // bootstrap only, no planning aggregation
    await dispatch(app, "PUT", "/api/profile", { ...goals, targetReading: 8 });
    await dispatch(app, "POST", "/api/plan-proposals/retry");
    assert.deepEqual(store.plan(), plan);
    assert.equal(modelCalls, 1);
  }));

  it("deduplicates concurrent bootstrap generation and repeated confirmation", async () => fixture(async (app, store, ai) => {
    store.saveProfile(goals);
    let calls = 0;
    ai.complete = async (messages) => { calls++; return reply(messages); };
    const boots = await Promise.all([dispatch(app, "GET", "/api/bootstrap"), dispatch(app, "GET", "/api/bootstrap")]);
    assert.ok(boots.every((boot) => boot.status === 200));
    await app.waitForBackgroundJobs();
    assert.equal(calls, 1);
    const id = store.planProposal().id;
    const first = await dispatch(app, "POST", "/api/plan-proposals/" + id + "/confirm");
    const plan = store.plan();
    const second = await dispatch(app, "POST", "/api/plan-proposals/" + id + "/confirm");
    assert.equal(first.status, 200); assert.equal(second.status, 200);
    assert.deepEqual(store.plan(), plan);
  }));

  it("keeps the old plan on planning service failure and builds a retry input only once", async () => fixture(async (app, store, ai) => {
    store.saveProfile(goals);
    store.savePlan([task(store, "active")], "active");
    const previous = store.plan();
    ai.complete = async () => { throw new Error("规划服务超时"); };
    await dispatch(app, "GET", "/api/bootstrap");
    await app.waitForBackgroundJobs();
    assert.equal(store.planProposal().status, "failed");
    assert.deepEqual(store.plan(), previous);
    let evidenceCalls = 0, modelCalls = 0;
    const evidence = store.evidence.bind(store);
    store.evidence = () => { evidenceCalls++; return evidence(); };
    ai.complete = async (messages) => { modelCalls++; return reply(messages); };
    assert.equal((await dispatch(app, "POST", "/api/plan-proposals/retry")).status, 200);
    await app.waitForBackgroundJobs();
    assert.equal(evidenceCalls, 2); assert.equal(modelCalls, 1);
    assert.equal(store.planProposal().status, "ready");
    assert.deepEqual(store.plan(), previous);
  }));

  it("exposes a stale generating state and recovers once while rejecting the old result", async () => fixture(async (app, store, ai) => {
    store.saveProfile(goals);
    let release: () => void = () => {};
    let calls = 0;
    ai.complete = async (messages) => {
      calls++;
      if (calls === 1) await new Promise<void>((resolve) => { release = resolve; });
      return reply(messages);
    };
    try {
      await dispatch(app, "GET", "/api/bootstrap");
      const first = store.planProposal().id;
      store.database.prepare("UPDATE plan_proposals SET updated_at=?").run("2020-01-01T00:00:00.000Z");
      const status = await dispatch(app, "GET", "/api/plan-proposals/status");
      assert.equal(status.body.proposal.recoverable, true);
      assert.equal(calls, 1); // status reads never start recovery
      await dispatch(app, "POST", "/api/plan-proposals/retry");
      const current = store.planProposal().id;
      assert.notEqual(current, first);
      await dispatch(app, "POST", "/api/plan-proposals/retry");
      assert.equal(calls, 2);
      release(); await app.waitForBackgroundJobs();
      assert.equal(store.planProposal().id, current);
      assert.equal(store.planProposal().status, "ready");
    } finally { release(); }
  }));

  it("reports committed profile changes when bootstrap assembly fails", async () => fixture(async (app, store) => {
    const evidence = store.evidence.bind(store);
    store.evidence = () => { throw new Error("temporary read failure"); };
    const result = await dispatch(app, "PUT", "/api/profile", goals);
    assert.equal(result.status, 503);
    assert.equal(result.body.applied, true);
    assert.match(result.body.error, /目标已保存/);
    assert.equal(store.profile().setupComplete, true);
    assert.equal(store.profile().dailyMinutes, goals.dailyMinutes);
    store.evidence = evidence;
  }));
});

describe("API-01 application invariants", () => {
  it("never clears a valid plan when persisted proposal tasks are empty or malformed", async () => fixture(async (_app, store) => {
    store.saveProfile(goals);
    store.savePlan([task(store, "active")], "old");
    const previous = store.plan();
    for (const json of ["[]", "not-json", "{}"]) {
      const id = store.beginPlanProposal("revision");
      store.completePlanProposal(id, [], []);
      store.database.prepare("UPDATE plan_proposals SET tasks_json=? WHERE id=?").run(json, id);
      assert.equal(store.applyPlanProposal(id), false);
      assert.equal(store.planProposal().status, "failed");
      assert.deepEqual(store.plan(), previous);
    }
  }));

  it("checks the latest budget inside SQLite apply and keeps old tasks on failure", async () => fixture(async (_app, store) => {
    store.saveProfile(goals);
    const active = task(store, "active");
    store.savePlan([active], "old");
    const previous = store.plan();
    const id = store.beginPlanProposal("revision");
    store.completePlanProposal(id, [task(store, "next", { minutes: 20 })], []);
    store.saveProfile({ ...goals, dailyMinutes: 15 });
    assert.equal(store.applyPlanProposal(id), false);
    assert.equal(store.planProposal().status, "failed");
    assert.match(store.planProposal().error!, /每日学习时间/);
    assert.deepEqual(store.plan(), previous);
  }));

  it("protects locked and completed question scopes when applying a ready proposal", async () => fixture(async (_app, store) => {
    store.saveProfile(goals);
    for (const fixed of [task(store, "locked", { locked: true }), task(store, "done", { status: "done" })]) {
      store.savePlan([fixed], "old");
      store.setPlanTask(fixed.id, { locked: fixed.locked, status: fixed.status === "done" ? "done" : "pending" });
      const previous = store.plan();
      const id = store.beginPlanProposal("revision");
      store.completePlanProposal(id, [task(store, "duplicate-" + fixed.id, { questionIds: fixed.questionIds })], []);
      assert.equal(store.applyPlanProposal(id), false);
      assert.equal(store.planProposal().status, "failed");
      assert.deepEqual(store.plan(), previous);
    }
  }));

  it("rejects previous-day confirmation and rolls back without changing any task", async () => fixture(async (app, store) => {
    store.saveProfile(goals);
    store.savePlan([task(store, "active")], "old");
    const id = store.beginPlanProposal("revision", "2000-01-01");
    store.completePlanProposal(id, [task(store, "old", { date: "2000-01-01" })], []);
    const previous = store.plan();
    assert.throws(() => store.applyPlanProposal(id), /不属于今天/);
    assert.equal((await dispatch(app, "POST", "/api/plan-proposals/" + id + "/confirm")).status, 409);
    assert.deepEqual(store.plan(), previous);
    assert.equal(store.planProposal().status, "ready");
  }));

  it("rolls back all replacements when task insertion fails", async () => fixture(async (_app, store) => {
    store.saveProfile(goals);
    const fixed = task(store, "fixed", { locked: true });
    const pending = task(store, "pending");
    store.savePlan([fixed, pending], "old");
    store.setPlanTask(fixed.id, { locked: true });
    const previous = store.plan();
    const id = store.beginPlanProposal("revision");
    // Duplicate task primary key, but a distinct question scope.
    store.completePlanProposal(id, [task(store, "fixed", { questionIds: ["new-question"] })], []);
    assert.throws(() => store.applyPlanProposal(id));
    assert.deepEqual(store.plan(), previous);
    assert.equal(store.planProposal().status, "ready");
  }));

  it("rejects model choices overlapping fixed questions and omits private free text", () => {
    const fixed: PlanTask = { id: "fixed", date: "2026-10-23", activityId: "activity", pluginId: "reading",
      kind: "diagnostic", title: "PRIVATE-TITLE", description: "PRIVATE-DESCRIPTION", reason: "PRIVATE-REASON",
      minutes: 2, questionIds: ["q1"], locked: true, status: "pending" };
    const input: PlanningInput = {
      today: fixed.date, profile: goals, currentTasks: [fixed], fixedTasks: [fixed], overdueTasks: [fixed],
      evidence: [{ pluginId: "reading", skillTag: "reading.detail", observed: 0, independent: 0, total: 1,
        hinted: 0, lastSeen: "", confidence: "emerging", userConfirmedCause: "PRIVATE-ANSWER" }],
      units: [{ id: "unit", activityId: "activity", pluginId: "reading", title: "PRIVATE-CATALOG", taskKind: "diagnostic",
        questionKind: "choice", questionIds: ["q1"], focusSkillTag: "reading.detail", skillTags: ["reading.detail"],
        questionCount: 1, minutes: 2, difficulty: 1, novelty: "fresh", evidenceStatus: "insufficient" }],
      requiredBaselineSections: ["reading"],
    };
    assert.throws(() => validatePlan({ tasks: [{ unitId: "unit", reason: "练习" }] }, input), /重复安排/);
    assert.equal(JSON.stringify(planningPayload(input)).includes("PRIVATE"), false);
    input.units[0]!.questionIds = ["q2"];
    const plan = validatePlan({ tasks: [{ unitId: "unit", reason: "练习" }] }, input);
    assert.deepEqual(plan[0]!.questionIds, ["q2"]);
  });

  it("keeps timing estimates identical across five-sample and fallback paths", () => {
    const questions = Array.from({ length: 6 }, (_, i) => ({
      id: "q" + i, kind: "choice" as const, prompt: "private", options: ["A", "B"], correctAnswer: "A",
      evidence: "private", explanation: "private", skillTags: ["reading.detail"],
    }));
    const activity = { id: "reading", pluginId: "reading" as const, title: "reading", description: "", minutes: 18,
      difficulty: 1 as const, sample: false, passage: { title: "", text: "" }, questions };
    const timings = questions.map((question, i) => ({ questionId: question.id, seconds: (i + 1) * 60, submittedAt: "" }));
    const base = { activities: [activity], attemptedQuestionIds: [], evidence: [], dueReviews: [] };
    assert.deepEqual(buildPlanningUnits({ ...base, timingSamples: timings.slice(0, 4) }).map((unit) => unit.minutes), [15, 3]);
    assert.deepEqual(buildPlanningUnits({ ...base, timingSamples: timings.slice(0, 5) }).map((unit) => unit.minutes), [15, 3]);
    assert.deepEqual(buildPlanningUnits({ ...base, timingSamples: timings }).map((unit) => unit.minutes), [18, 4]);
  });
});

describe("API-01 Neon SQL contract (recording client, not a live database)", () => {
  for (const scenario of ["budget", "overlap", "success", "lost-update"] as const) {
    it("locks and validates before replacing tasks: " + scenario, async () => {
      const statements: string[] = [];
      const day = new LearningDay().today();
      const next: PlanTask = { id: "new", date: day, activityId: "reading", pluginId: "reading", kind: "practice",
        title: "", description: "", reason: "", minutes: 20, questionIds: [scenario === "overlap" ? "fixed-q" : "new-q"], locked: false, status: "pending" };
      const client = { query: async (sql: string) => {
        statements.push(sql);
        let rows: Record<string, unknown>[] = [];
        if (sql.startsWith("SELECT tasks_json")) rows = [{ tasks_json: JSON.stringify([next]), planDate: day }];
        else if (sql.startsWith("SELECT daily_minutes")) rows = [{ daily_minutes: scenario === "budget" ? 15 : 180 }];
        else if (sql.includes('activity_id AS "activityId"')) rows = [{ id: "fixed", date: day, activityId: "reading",
          pluginId: "reading", kind: "practice", minutes: 5, questionIdsJson: '["fixed-q"]', reviewQuestionIdsJson: "[]", locked: true, status: "pending" }];
        return { rows, rowCount: scenario === "lost-update" && sql.includes("status='confirmed'") ? 0 : 1 };
      } };
      const store = new PostgresLearningStore(client as unknown as ConstructorParameters<typeof PostgresLearningStore>[0]);
      assert.equal(await store.applyPlanProposal("proposal"), scenario === "success");
      const profileLock = statements.findIndex((sql) => sql.startsWith("SELECT daily_minutes") && sql.endsWith("FOR UPDATE"));
      const taskLock = statements.findIndex((sql) => sql.startsWith("SELECT id FROM plan_tasks") && sql.endsWith("FOR UPDATE"));
      assert.ok(profileLock > 0 && taskLock > profileLock);
      const deletion = statements.findIndex((sql) => sql.startsWith("DELETE FROM plan_tasks"));
      if (scenario === "budget" || scenario === "overlap") {
        assert.equal(deletion, -1);
        assert.ok(statements.some((sql) => sql.includes("status='failed'")));
        assert.equal(statements.at(-1), "COMMIT");
      } else {
        assert.ok(deletion > taskLock);
        assert.equal(statements.at(-1), scenario === "success" ? "COMMIT" : "ROLLBACK");
      }
    });
  }
});
class LearningDay { today() { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); } }

describe("API-01 browser state helpers", () => {
  it("keeps dirty goals across refreshed snapshots and acknowledges only the submitted values", () => {
    const initial: GoalFormState = { value: goals, dirty: false, saved: false };
    const edit = { ...goals, targetReading: 8 };
    const dirty = goalFormReducer(initial, { type: "change", value: edit });
    assert.equal(goalFormReducer(dirty, { type: "sync", value: { ...goals } }), dirty);
    assert.equal(goalFormReducer(dirty, { type: "saved", value: goals }), dirty);
    const saved = goalFormReducer(dirty, { type: "saved", value: edit });
    assert.equal(saved.saved, true); assert.equal(saved.dirty, false);
    assert.equal(goalFormReducer(saved, { type: "sync", value: { ...edit } }), saved);
    assert.equal(goalFormReducer(saved, { type: "change", value: goals }).saved, false);
  });

  it("allows only one status request in flight and refreshes a terminal state once", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let calls = 0, refreshes = 0;
    let resolve: (result: { proposal: PlanProposal }) => void = () => {};
    const stop = startPlanPolling({ proposalId: "p", read: () => { calls++; return new Promise((done) => { resolve = done; }); },
      settled: async () => { refreshes++; }, error: () => assert.fail("unexpected error") });
    try {
      t.mock.timers.tick(2500); assert.equal(calls, 1);
      t.mock.timers.tick(25_000); assert.equal(calls, 1);
      resolve({ proposal: { id: "p", status: "ready", changes: [] } });
      await new Promise<void>((done) => setImmediate(done));
      t.mock.timers.tick(25_000);
      assert.equal(calls, 1); assert.equal(refreshes, 1);
    } finally { stop(); }
  });

  it("cancels pending polling without refreshing or reporting an error", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let resolve: (result: { proposal: PlanProposal }) => void = () => {};
    let signal: AbortSignal | undefined;
    const stop = startPlanPolling({ proposalId: "p", read: (value) => { signal = value; return new Promise((done) => { resolve = done; }); },
      settled: async () => assert.fail("cancelled refresh"), error: () => assert.fail("cancelled error") });
    t.mock.timers.tick(2500); stop();
    assert.equal(signal?.aborted, true);
    resolve({ proposal: { id: "p", status: "ready", changes: [] } });
    await new Promise<void>((done) => setImmediate(done));
  });

  it("retries status failures and stops at a recoverable generating state", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let calls = 0, errors = 0, refreshes = 0;
    const stop = startPlanPolling({ proposalId: "p", read: async () => {
      if (++calls === 1) throw new Error("offline");
      return { proposal: { id: "p", status: "generating", recoverable: true, changes: [] } };
    }, settled: async () => { refreshes++; }, error: () => { errors++; } });
    try {
      t.mock.timers.tick(2500); await new Promise<void>((done) => setImmediate(done));
      t.mock.timers.tick(2500); await new Promise<void>((done) => setImmediate(done));
      t.mock.timers.tick(25_000);
      assert.equal(errors, 1); assert.equal(calls, 2); assert.equal(refreshes, 1);
    } finally { stop(); }
  });

  it("rejects invalid successful responses and preserves committed-write information", async () => {
    const previous = globalThis.fetch;
    try {
      globalThis.fetch = async () => new Response("<html>gateway</html>");
      await assert.rejects(api.bootstrap(), /格式无效/);
      globalThis.fetch = async () => new Response("{}");
      await assert.rejects(api.bootstrap(), /格式无效/);
      await assert.rejects(api.planProposalStatus(), /格式无效/);
      globalThis.fetch = async () => new Response(JSON.stringify({ error: "目标已保存，但刷新失败", applied: true }), { status: 503 });
      await assert.rejects(api.setProfile({ ...goals, setupComplete: true }), (reason: unknown) =>
        reason instanceof ApiError && reason.applied && reason.status === 503);
    } finally { globalThis.fetch = previous; }
  });

  it("bounds a hanging request and never automatically repeats a write", async () => {
    const previousFetch = globalThis.fetch, previousTimeout = AbortSignal.timeout;
    const controller = new AbortController();
    let calls = 0;
    try {
      AbortSignal.timeout = () => controller.signal;
      globalThis.fetch = async (_url, init) => { calls++; return new Promise((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
      }); };
      const pending = api.setProfile({ ...goals, setupComplete: true });
      controller.abort(new DOMException("timeout", "TimeoutError"));
      await assert.rejects(pending, /操作结果尚未确认/);
      assert.equal(calls, 1);
    } finally { globalThis.fetch = previousFetch; AbortSignal.timeout = previousTimeout; }
  });
});
