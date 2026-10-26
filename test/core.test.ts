import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable, Writable } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Activity, PlanTask, Question } from "../src/shared/domain.js";
import { assertActivity } from "../src/shared/validation.js";
import { LearningStore } from "../server/db.js";
import { PostgresLearningStore } from "../server/postgres-store.js";
import { createApp } from "../server/index.js";
import { HttpError, errorResponse } from "../server/http-error.js";
import { StoreError } from "../server/store-error.js";
import { PluginRegistry, toPublicActivity } from "../server/plugins/registry.js";
import { AiPlanner, diffPlan, fitsDailyBudget, validatePlan, type PlanningInput } from "../server/services/ai-planner.js";
import { AiClient } from "../server/services/ai-client.js";
import { listCompleteMocks, composeMock } from "../server/services/mock-sets.js";
import { buildPlanningUnits, expandQuestionGroups, type PlanningUnit } from "../server/services/planning-units.js";
import { api, ApiError, setUnauthorizedHandler } from "../src/services/api.js";

let directory = "";
let store: LearningStore;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "ielts-demo-test-")); store = new LearningStore(join(directory, "test.sqlite")); });
afterEach(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });

function question(id: string): Question {
  return { id, prompt: "Choose the supported statement.", kind: "choice", options: ["A", "B"], skillTags: ["reading.evidence"], correctAnswer: "A", evidence: "The text supports A.", explanation: "The evidence matches A." };
}
function readingPart(part: number, count: number, mockId = "practice-set"): Activity {
  return {
    id: "reading-part-" + part, pluginId: "reading", title: "Passage " + part, description: "Material",
    minutes: 15, difficulty: 2, sample: false, mockId, part: part as Activity["part"],
    passage: { title: "Passage " + part, text: "A paragraph." },
    questions: Array.from({ length: count }, (_, index) => question("reading-q-" + part + "-" + index)),
  };
}
function listeningPart(part: number, count: number, mockId = "listening-set"): Activity {
  return {
    id: "listening-part-" + part, pluginId: "listening", title: "Section " + part, description: "Material",
    minutes: 10, difficulty: 2, sample: false, mockId, part: part as Activity["part"], audioUrl: "/media/test-" + part + ".wav", transcript: "A clear transcript.",
    questions: Array.from({ length: count }, (_, index) => ({ ...question("listening-q-" + part + "-" + index), skillTags: ["listening.detail"] })),
  };
}

function planTask(id: string, date: string, activityId: string, overrides: Partial<PlanTask> = {}): PlanTask {
  const pluginId = activityId.startsWith("listening") ? "listening" : "reading";
  return { id, date, activityId, pluginId, kind: "practice", title: activityId, description: "Practice", minutes: 10, reason: "练习", locked: false, status: "pending", ...overrides };
}

function planningInput(): PlanningInput {
  const today = store.today();
  const base = (overrides: Partial<PlanningUnit>): PlanningUnit => ({
    id: "unit-reading", activityId: "reading-part-1", pluginId: "reading", title: "Reading set", taskKind: "diagnostic",
    questionKind: "choice", questionIds: ["reading-q1"], focusSkillTag: "reading.evidence", skillTags: ["reading.evidence"],
    questionCount: 1, minutes: 10, difficulty: 2, novelty: "fresh", evidenceStatus: "insufficient", ...overrides,
  });
  return {
    today,
    profile: { targetListening: 7.5, targetReading: 7, examDate: "2026-12-12", dailyMinutes: 30 },
    evidence: [], currentTasks: [], fixedTasks: [], overdueTasks: [], requiredBaselineSections: ["reading", "listening"],
    units: [base({}), base({ id: "unit-listening", activityId: "listening-part-1", pluginId: "listening", title: "Listening set", taskKind: "diagnostic", questionIds: ["listening-q1"], focusSkillTag: "listening.detail", skillTags: ["listening.detail"], minutes: 8, difficulty: 1 })],
  };
}

function dispatcher(app: Awaited<ReturnType<typeof createApp>>) {
  return async (method: string, path: string, payload?: unknown) => {
    let status = 200; let bodyText = ""; let headersSent = false;
    const raw = payload === undefined ? "" : JSON.stringify(payload);
    const req = { url: path, method, headers: { host: "127.0.0.1", "content-type": "application/json" }, async *[Symbol.asyncIterator]() { if (raw) yield Buffer.from(raw); } } as unknown as IncomingMessage;
    const res = { get headersSent() { return headersSent; }, writeHead(code: number) { status = code; headersSent = true; return res; }, end(value?: string) { bodyText = String(value ?? ""); } } as unknown as ServerResponse;
    try { await app.handle(req, res); }
    catch (error) { status = Number((error as { status?: number }).status ?? 500); bodyText = JSON.stringify({ error: error instanceof Error ? error.message : "error" }); }
    return { status, json: JSON.parse(bodyText || "{}") as Record<string, unknown> };
  };
}

type Sink = Writable & { status?: number; headers?: Record<string, unknown>; headersSent: boolean; writeHead: (status: number, headers?: Record<string, unknown>) => unknown; chunks: Buffer[] };
function createSink(): Sink {
  const chunks: Buffer[] = [];
  const sink = new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } }) as Sink;
  let headersSent = false;
  sink.chunks = chunks;
  sink.writeHead = (status, headers) => { sink.status = status; headersSent = true; sink.headers = headers; return sink; };
  Object.defineProperty(sink, "headersSent", { get: () => headersSent });
  return sink;
}

describe("mock readiness", () => {
  it("opens full mocks only with the correct part and question counts", () => {
    const reading = [readingPart(1, 14), readingPart(2, 13), readingPart(3, 13)];
    const listening = [listeningPart(1, 10), listeningPart(2, 10), listeningPart(3, 10), listeningPart(4, 10)];
    assert.equal(listCompleteMocks(reading).find((item) => item.section === "reading")?.ready, true);
    assert.equal(listCompleteMocks(listening).find((item) => item.section === "listening")?.ready, true);
    assert.equal(composeMock("reading", "practice-set", reading)?.questions.length, 40);
    assert.equal(composeMock("listening", "listening-set", listening)?.questions.length, 40);
    assert.equal(listCompleteMocks(reading.slice(0, 2))[0]?.ready, false);
  });

  it("does not expose answer keys or listening transcripts to the browser", () => {
    const activity = listeningPart(1, 1);
    activity.questions[0]!.answerGroupId = "shared-answer-1";
    activity.questions[0]!.answerGroupValues = ["A", "B"];
    activity.questions[0]!.answerLabel = "A. the shared answer";
    const publicValue = toPublicActivity(activity);
    assert.equal("correctAnswer" in publicValue.questions[0]!, false);
    assert.equal(publicValue.questions[0]!.answerGroupId, "shared-answer-1");
    assert.equal("answerGroupValues" in publicValue.questions[0]!, false);
    assert.equal("answerLabel" in publicValue.questions[0]!, false);
    assert.equal(publicValue.transcript, undefined);
    assert.equal(publicValue.audioSections, undefined);
  });
});

describe("reading option labels", () => {
  const matchingActivity = (tag: string, labels?: Record<string, string>): Activity => {
    const activity = readingPart(1, 1);
    activity.questions = [{
      ...question("reading-q-option-label"),
      options: ["option.a", "option.b"],
      correctAnswer: "option.a",
      skillTags: [tag],
      ...(labels ? { optionLabels: labels } : {}),
    }];
    return activity;
  };

  it("accepts list text on options that are rendered beside their letter", () => {
    assert.doesNotThrow(() => assertActivity(matchingActivity("reading.matching-features", {
      "option.a": "A. Anthony Pellegrini",
      "option.b": "B. Jaak Panksepp",
    })));
  });

  it("rejects options that lost their list text and would render as bare letters", () => {
    assert.throws(() => assertActivity(matchingActivity("reading.matching-features", {
      "option.a": "A. A",
      "option.b": "B. B",
    })), /缺少列表正文/);
  });

  it("leaves paragraph questions alone, since their options are legitimately letters", () => {
    assert.doesNotThrow(() => assertActivity(matchingActivity("reading.matching-information", {
      "option.a": "A. A",
      "option.b": "B. B",
    })));
  });
});

describe("adaptive planning units", () => {  it("keeps connected group and shared-answer questions together without sending question content", () => {
    const activity = readingPart(1, 3);
    activity.questions[0]!.groupId = "instructions-1";
    activity.questions[1]!.groupId = "instructions-1";
    activity.questions[1]!.answerGroupId = "shared-answer-1";
    activity.questions[2]!.answerGroupId = "shared-answer-1";
    assert.throws(() => expandQuestionGroups(activity, [activity.questions[0]!.id]), /拆分了关联题组/);
    assert.deepEqual(expandQuestionGroups(activity, activity.questions.map((item) => item.id)), activity.questions.map((item) => item.id));
    const units = buildPlanningUnits({ activities: [activity], attemptedQuestionIds: [], timingSamples: [], evidence: [], dueReviews: [] });
    const group = units.find((unit) => unit.questionIds.length === 3);
    assert.ok(group);
    assert.deepEqual(group.questionIds, activity.questions.map((item) => item.id));
    assert.equal(JSON.stringify(group).includes(activity.questions[0]!.prompt), false);
  });

  it("estimates short groups from the activity until five comparable timing samples exist", () => {
    const activity = readingPart(1, 5);
    const noSamples = buildPlanningUnits({ activities: [activity], attemptedQuestionIds: [], timingSamples: [], evidence: [], dueReviews: [] });
    assert.equal(noSamples[0]?.minutes, 15);
    const samples = activity.questions.slice(0, 5).map((item, index) => ({ questionId: item.id, seconds: 30 + index * 10, submittedAt: new Date().toISOString() }));
    const withSamples = buildPlanningUnits({ activities: [activity], attemptedQuestionIds: [], timingSamples: samples, evidence: [], dueReviews: [] });
    assert.equal(withSamples[0]?.minutes, 5);
  });
});

describe("learning records and plugin host", () => {
  it("persists per-question time, restores it, and excludes review from transfer evidence", async () => {
    const activity = readingPart(1, 1);
    const questionId = activity.questions[0]!.id;
    const draft = store.startAttempt(activity.id, "practice", undefined, undefined, [questionId]);
    const saved = store.saveDraft(draft.attemptId, { [questionId]: "A" }, { [questionId]: 42 }, 100);
    assert.deepEqual(saved.questionTimeSeconds, { [questionId]: 42 });
    assert.equal(saved.saveRevision, 100);
    const staleSave = store.saveDraft(draft.attemptId, { [questionId]: "A" }, { [questionId]: 5 }, 99);
    assert.deepEqual(staleSave.questionTimeSeconds, { [questionId]: 42 });
    assert.equal(staleSave.saveRevision, 100);
    assert.equal(store.saveDraft(draft.attemptId, { [questionId]: "A" }, { [questionId]: 3 }, 100).saveRevision, 100);
    const latestSave = store.saveDraft(draft.attemptId, { [questionId]: "A" }, { [questionId]: 7 }, 101);
    assert.equal(latestSave.saveRevision, 101);
    assert.deepEqual(latestSave.questionTimeSeconds, { [questionId]: 42 });
    assert.deepEqual(store.draft(draft.attemptId)?.questionIds, [questionId]);
    const response = {
      questionId, correct: true, independent: true, selected: "A", correctAnswer: "A",
      evidence: "A paragraph supports the answer.", explanation: "The answer matches the text.",
      skillTags: activity.questions[0]!.skillTags, materialId: activity.id,
    };
    const result = store.submitDraft(staleSave, activity, [response]);
    assert.deepEqual(result.questionTimeSeconds, { [questionId]: 42 });
    assert.deepEqual(store.attempt(result.attemptId)?.questionTimeSeconds, { [questionId]: 42 });
    assert.deepEqual(store.attempt(result.attemptId)?.questionIds, [questionId]);
    assert.deepEqual(store.attemptedQuestionIds(), [questionId]);
    assert.deepEqual(store.questionTimingSamples().map((item) => [item.questionId, item.seconds]), [[questionId, 42]]);
    const evidence = store.evidence().find((item) => item.skillTag === "reading.evidence");
    assert.equal(evidence?.recentIndependentSamples, 1);
    assert.equal(evidence?.recentIndependentCorrect, 1);
    const review = store.startAttempt(activity.id, "review", undefined, [questionId], [questionId]);
    const reviewed = store.submitDraft(review, activity, [{ ...response, correct: false, independent: true }]);
    assert.equal(reviewed.mode, "review");
    assert.equal(store.evidence().find((item) => item.skillTag === "reading.evidence")?.total, 1);
    assert.equal(store.questionTimingSamples().length, 1);
  });

  it("adds question-group and timing columns when opening an older SQLite database", () => {
    const path = join(directory, "legacy.sqlite");
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE drafts (id TEXT PRIMARY KEY, activity_id TEXT NOT NULL, mode TEXT NOT NULL, answers_json TEXT NOT NULL, hinted_json TEXT NOT NULL, started_at TEXT NOT NULL, updated_at TEXT NOT NULL, status TEXT NOT NULL, interruption TEXT, task_id TEXT, review_question_ids_json TEXT NOT NULL DEFAULT '[]');
      CREATE TABLE attempts (id TEXT PRIMARY KEY, activity_id TEXT NOT NULL, plugin_id TEXT NOT NULL, mode TEXT NOT NULL, answers_json TEXT NOT NULL, hinted_json TEXT NOT NULL, started_at TEXT NOT NULL, submitted_at TEXT NOT NULL, score INTEGER NOT NULL, total INTEGER NOT NULL, responses_json TEXT NOT NULL, sample INTEGER NOT NULL);
      CREATE TABLE plan_tasks (id TEXT PRIMARY KEY, date TEXT NOT NULL, activity_id TEXT NOT NULL, plugin_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL, minutes INTEGER NOT NULL, reason TEXT NOT NULL, review_question_ids_json TEXT NOT NULL DEFAULT '[]', locked INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending', revision TEXT NOT NULL);
      CREATE TABLE plan_proposals (singleton INTEGER PRIMARY KEY, id TEXT NOT NULL, status TEXT NOT NULL, input_revision TEXT NOT NULL, tasks_json TEXT NOT NULL, changes_json TEXT NOT NULL, error TEXT, updated_at TEXT NOT NULL);
    `);
    legacy.prepare(`INSERT INTO plan_tasks (id, date, activity_id, plugin_id, kind, title, description, minutes, reason, revision)
      VALUES ('legacy-task', '2026-10-14', 'reading-part-1', 'reading', 'practice', 'Legacy plan', '', 10, '', 'old')`).run();
    legacy.close();
    const migrated = new LearningStore(path);
    try {
      const columns = (table: string) => new Set((migrated.database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((item) => item.name));
      assert.ok(columns("drafts").has("question_ids_json"));
      assert.ok(columns("drafts").has("question_time_seconds_json"));
      assert.ok(columns("drafts").has("client_revision"));
      assert.ok(columns("attempts").has("question_time_seconds_json"));
      assert.ok(columns("plan_tasks").has("question_ids_json"));
      assert.ok(columns("plan_tasks").has("question_kind"));
      assert.ok(columns("plan_proposals").has("plan_date"));
      assert.equal((migrated.database.prepare("SELECT status FROM plan_tasks WHERE id='legacy-task'").get() as { status: string }).status, "expired");
    } finally { migrated.close(); }
  });

  it("migrates Neon plan fields and retires legacy unscoped tasks", async () => {
    const statements: string[] = [];
    const client = { query: async (sql: string) => { statements.push(sql); return { rows: [] }; } };
    const migrated = new PostgresLearningStore(client as never);
    await migrated.initialize();
    assert.ok(statements.includes("ALTER TABLE plan_tasks ADD COLUMN IF NOT EXISTS question_ids_json TEXT NOT NULL DEFAULT '[]'"));
    assert.ok(statements.includes("ALTER TABLE drafts ADD COLUMN IF NOT EXISTS question_time_seconds_json TEXT NOT NULL DEFAULT '{}'"));
    assert.ok(statements.includes("ALTER TABLE drafts ADD COLUMN IF NOT EXISTS client_revision BIGINT NOT NULL DEFAULT 0"));
    assert.ok(statements.includes("UPDATE plan_tasks SET status='expired' WHERE status='pending' AND question_ids_json='[]'"));
  });

  it("serves and grades only selected complete question groups", async () => {
    const activity = readingPart(1, 3);
    activity.id = "reading-selected-groups";
    activity.questions[0]!.groupId = "pair-one";
    activity.questions[1]!.groupId = "pair-one";
    const app = await createApp({ dataDirectory: join(directory, "api"), pluginDirectory: join(process.cwd(), "plugins"), activities: [activity] });
    try {
      const dispatch = async (method: string, path: string, payload?: unknown) => {
        let status = 200; let bodyText = ""; let headersSent = false;
        const raw = payload === undefined ? "" : JSON.stringify(payload);
        const req = { url: path, method, headers: { host: "127.0.0.1", "content-type": "application/json" }, async *[Symbol.asyncIterator]() { if (raw) yield Buffer.from(raw); } } as unknown as IncomingMessage;
        const res = { get headersSent() { return headersSent; }, writeHead(code: number) { status = code; headersSent = true; return res; }, end(value?: string) { bodyText = String(value ?? ""); } } as unknown as ServerResponse;
        try { await app.handle(req, res); }
        catch (error) { status = Number((error as { status?: number }).status ?? 500); bodyText = JSON.stringify({ error: error instanceof Error ? error.message : "error" }); }
        return { status, json: JSON.parse(bodyText || "{}") as Record<string, unknown> };
      };
      const invalid = await dispatch("POST", "/api/attempts", { activityId: activity.id, mode: "practice", questionIds: [activity.questions[0]!.id] });
      assert.equal(invalid.status, 400);
      const startedResponse = await dispatch("POST", "/api/attempts", { activityId: activity.id, mode: "practice", questionIds: activity.questions.slice(0, 2).map((item) => item.id) });
      assert.equal(startedResponse.status, 201);
      const started = startedResponse.json as unknown as { draft: { attemptId: string }; activity: Activity };
      assert.equal(started.activity.questions.length, 2);
      const outOfScope = await dispatch("PATCH", `/api/attempts/${started.draft.attemptId}/draft`, { answers: { [activity.questions[2]!.id]: "A" } });
      assert.equal(outOfScope.status, 400);
      const saved = await dispatch("PATCH", `/api/attempts/${started.draft.attemptId}/draft`, { answers: { [activity.questions[0]!.id]: "A", [activity.questions[1]!.id]: "A" }, questionTimeSeconds: { [activity.questions[0]!.id]: 12, [activity.questions[1]!.id]: 7 } });
      assert.equal(saved.status, 200);
      const submitted = await dispatch("POST", `/api/attempts/${started.draft.attemptId}/submit`, {});
      const result = submitted.json as unknown as { result: { total: number; questionTimeSeconds: Record<string, number> } };
      assert.equal(result.result.total, 2);
      assert.deepEqual(result.result.questionTimeSeconds, { [activity.questions[0]!.id]: 12, [activity.questions[1]!.id]: 7 });
    } finally { await app.close(); }
  });

  it("requires submission before transcript and analysis, and keeps completed scope", async () => {
    const activity = listeningPart(1, 3);
    activity.id = "listening-scope";
    const app = await createApp({ dataDirectory: join(directory, "scope"), pluginDirectory: join(process.cwd(), "plugins"), activities: [activity] });
    try {
      const dispatch = async (method: string, path: string, payload?: unknown) => {
        let status = 200; let bodyText = ""; let headersSent = false;
        const raw = payload === undefined ? "" : JSON.stringify(payload);
        const req = { url: path, method, headers: { host: "127.0.0.1", "content-type": "application/json" }, async *[Symbol.asyncIterator]() { if (raw) yield Buffer.from(raw); } } as unknown as IncomingMessage;
        const res = { get headersSent() { return headersSent; }, writeHead(code: number) { status = code; headersSent = true; return res; }, end(value?: string) { bodyText = String(value ?? ""); } } as unknown as ServerResponse;
        try { await app.handle(req, res); }
        catch (error) { status = Number((error as { status?: number }).status ?? 500); bodyText = JSON.stringify({ error: error instanceof Error ? error.message : "error" }); }
        return { status, json: JSON.parse(bodyText || "{}") as Record<string, unknown> };
      };
      const questionId = activity.questions[0]!.id;
      const started = await dispatch("POST", "/api/attempts", { activityId: activity.id, mode: "practice", questionIds: [questionId] });
      assert.equal(started.status, 201);
      const attemptId = (started.json as unknown as { draft: { attemptId: string } }).draft.attemptId;
      assert.equal((await dispatch("GET", `/api/attempts/${attemptId}/transcript`)).status, 403);
      assert.equal((await dispatch("GET", `/api/attempts/${attemptId}/analysis`)).status, 403);
      assert.equal((await dispatch("PATCH", `/api/attempts/${attemptId}/draft`, { answers: { [questionId]: "A" } })).status, 200);
      assert.equal((await dispatch("POST", `/api/attempts/${attemptId}/submit`, {})).status, 200);
      assert.equal((await dispatch("GET", `/api/attempts/${attemptId}/transcript`)).status, 200);
      const analysis = await dispatch("GET", `/api/attempts/${attemptId}/analysis`);
      assert.equal(analysis.status, 200);
      const explanations = (analysis.json as unknown as { explanations: Array<{ questionId: string }> }).explanations;
      assert.deepEqual(explanations.map((item) => item.questionId), [questionId]);
      const reopened = await dispatch("GET", `/api/attempts/${attemptId}`);
      assert.equal(reopened.status, 200);
      assert.equal((reopened.json as unknown as { activity: { questions: unknown[] } }).activity.questions.length, 1);
    } finally { await app.close(); }
  });

  it("starts a review with the whole atomic group when one question is due", async () => {
    const activity = readingPart(1, 2);
    activity.id = "review-group";
    activity.questions[0]!.groupId = "group-one";
    activity.questions[1]!.groupId = "group-one";
    const app = await createApp({ dataDirectory: join(directory, "review-group"), pluginDirectory: join(process.cwd(), "plugins"), activities: [activity] });
    try {
      const local = app.store as LearningStore;
      const questionId = activity.questions[0]!.id;
      local.database.prepare("INSERT INTO review_schedule (question_id, activity_id, plugin_id, streak, interval_days, due_date, last_result, last_seen) VALUES (?, ?, ?, 0, 1, ?, 'incorrect', ?)")
        .run(questionId, activity.id, "reading", await app.store.today(), new Date().toISOString());
      let status = 200; let bodyText = "";
      const raw = JSON.stringify({ activityId: activity.id, mode: "review", reviewQuestionIds: [questionId] });
      const req = { url: "/api/attempts", method: "POST", headers: { host: "127.0.0.1", "content-type": "application/json" }, async *[Symbol.asyncIterator]() { yield Buffer.from(raw); } } as unknown as IncomingMessage;
      const res = { get headersSent() { return false; }, writeHead(code: number) { status = code; return res; }, end(value?: string) { bodyText = String(value ?? ""); } } as unknown as ServerResponse;
      try { await app.handle(req, res); }
      catch (error) { status = Number((error as { status?: number }).status ?? 500); bodyText = JSON.stringify({ error: error instanceof Error ? error.message : "error" }); }
      assert.equal(status, 201);
      const payload = JSON.parse(bodyText) as { draft: { questionIds: string[] }; activity: Activity };
      assert.deepEqual(payload.draft.questionIds, activity.questions.map((item) => item.id));
      assert.equal(payload.activity.questions.length, 2);
    } finally { await app.close(); }
  });

  it("maps HttpError statuses for both local and cloud entry points", () => {
    assert.deepEqual(errorResponse(new HttpError("冲突", 409)), { status: 409, body: { error: "冲突" } });
    assert.deepEqual(errorResponse(new StoreError("这份练习已结束", 409)), { status: 409, body: { error: "这份练习已结束" } });
    assert.deepEqual(errorResponse(new StoreError("找不到记录", 404)), { status: 404, body: { error: "找不到记录" } });
    assert.deepEqual(errorResponse(new Error("数据库错误")), { status: 500, body: { error: "服务暂时不可用，请稍后重试。" } });
  });

  it("scores once, stores evidence, and schedules missed questions", async () => {
    const app = await createApp({ dataDirectory: directory, pluginDirectory: join(process.cwd(), "plugins") });
    const activity = app.registry.builtinActivities().find((item) => item.id === "sample-reading-green-spaces")!;
    const draft = await app.store.startAttempt(activity.id, "practice");
    const grader = app.registry.grader("reading")!;
    const responses = grader(activity, { "read-q1": "TRUE" }, []);
    const first = await app.store.submitDraft(draft, activity, responses);
    const duplicate = await app.store.submitDraft(draft, activity, responses);
    assert.equal(first.score, 0);
    assert.equal(duplicate.attemptId, first.attemptId);
    assert.equal((await app.store.attempts()).length, 1);
    const evidenceBeforeReview = (await app.store.evidence()).reduce((sum, item) => sum + item.total, 0);
    assert.ok(evidenceBeforeReview > 0);
    const dueDate = new Date((await app.store.today()) + "T12:00:00+08:00");
    dueDate.setDate(dueDate.getDate() + 1);
    const due = dueDate.toISOString().slice(0, 10);
    assert.ok((await app.store.reviews(due)).some((item) => item.questionId === "read-q1"));
    const review = await app.store.startAttempt(activity.id, "review", undefined, ["read-q1"]);
    const reviewActivity = { ...activity, questions: activity.questions.filter((item) => item.id === "read-q1") };
    const reviewed = grader(reviewActivity, { "read-q1": "FALSE" }, []);
    await app.store.submitDraft(review, reviewActivity, reviewed);
    assert.equal((await app.store.evidence()).reduce((sum, item) => sum + item.total, 0), evidenceBeforeReview);
    const nextDue = new Date(due + "T12:00:00+08:00");
    nextDue.setDate(nextDue.getDate() + 1);
    assert.equal((await app.store.reviews(nextDue.toISOString().slice(0, 10))).find((item) => item.questionId === "read-q1")?.streak, 1);
    await app.registry.releaseAll();
    await app.store.close();
  });

  it("replaces only unlocked pending tasks when an AI proposal is confirmed", () => {
    const today = store.today();
    store.savePlan([
      planTask("locked-task", today, "reading-part-1"),
      planTask("done-task", today, "listening-part-1"),
      planTask("old-pending", today, "reading-part-2"),
    ], "old-revision");
    store.setPlanTask("locked-task", { locked: true });
    store.setPlanTask("done-task", { status: "done" });
    const proposal = store.beginPlanProposal("new-revision");
    const next = planTask("new-task", today, "listening-part-2");
    assert.equal(store.completePlanProposal(proposal, [next], [{ kind: "added", after: next }] ), true);
    assert.equal(store.applyPlanProposal(proposal), true);
    const tasks = store.plan();
    assert.equal(tasks.some((item) => item.id === "locked-task" && item.locked), true);
    assert.equal(tasks.some((item) => item.id === "done-task" && item.status === "done"), true);
    assert.equal(tasks.some((item) => item.id === "old-pending"), false);
    assert.equal(tasks.some((item) => item.id === "new-task"), true);
    assert.equal(store.planProposal().status, "confirmed");
  });

  it("ignores a stale AI result after a newer planning request starts", () => {
    const stale = store.beginPlanProposal("revision-1");
    const current = store.beginPlanProposal("revision-2");
    const task = planTask("current-task", store.today(), "reading-part-1");
    assert.equal(store.completePlanProposal(stale, [task], [{ kind: "added", after: task }]), false);
    assert.equal(store.completePlanProposal(current, [task], [{ kind: "added", after: task }]), true);
    assert.equal(store.planProposal().id, current);
  });

  it("keeps the active plan when a ready proposal fails its last budget check", () => {
    const today = store.today();
    const active = planTask("active-task", today, "reading-part-1");
    store.savePlan([active], "active");
    const proposal = store.beginPlanProposal("new-revision");
    const next = planTask("proposed-task", today, "listening-part-1");
    store.completePlanProposal(proposal, [next], [{ kind: "added", after: next }]);
    assert.equal(store.failReadyPlanProposal(proposal, "每日时间已超出"), true);
    assert.deepEqual(store.plan().map((item) => item.id), ["active-task"]);
    assert.equal(store.planProposal().status, "failed");
  });

  it("generates tasks from catalog metadata without sending question answers", async () => {
    const input = planningInput();
    let userPayload = "";
    let planningTimeout = 0;
    let planningReasoningEffort = "";
    let planningMaxTokens = 0;
    const client = new AiClient();
    client.complete = async (messages, options) => {
      userPayload = messages[1]!.content;
      planningTimeout = options?.timeoutMs ?? 0;
      planningReasoningEffort = options?.reasoningEffort ?? "";
      planningMaxTokens = options?.maxTokens ?? 0;
      return JSON.stringify({ tasks: [
        { unitId: "unit-reading", reason: "建立阅读基线，观察定位信息能力。" },
        { unitId: "unit-listening", reason: "建立听力基线，观察细节捕捉能力。" },
      ] });
    };
    const tasks = await new AiPlanner(client).generate(input);
    assert.equal(tasks.reduce((sum, item) => sum + item.minutes, 0), 18);
    assert.equal(tasks.find((item) => item.activityId === "reading-part-1")?.title, "Reading set");
    assert.equal(userPayload.includes("correctAnswer"), false);
    assert.equal(userPayload.includes("explanation"), false);
    assert.equal(userPayload.includes("Choose the supported statement"), false);
    assert.equal(planningTimeout, 45_000);
    assert.equal(planningReasoningEffort, "low");
    assert.equal(planningMaxTokens, 6000);
  });

  it("sends OpenCode session headers consistently", async () => {
    const keys = ["IELTS_AI_BASE_URL", "IELTS_AI_MODEL", "IELTS_AI_API_KEY", "IELTS_AI_SESSION_ID"] as const;
    const previous = keys.map((key) => process.env[key]);
    const originalFetch = globalThis.fetch;
    const captured: Headers[] = [];
    process.env.IELTS_AI_BASE_URL = "https://example.test/v1";
    process.env.IELTS_AI_MODEL = "model";
    process.env.IELTS_AI_API_KEY = "test-key";
    delete process.env.IELTS_AI_SESSION_ID;
    globalThis.fetch = async (_input, init) => {
      captured.push(new Headers(init?.headers));
      return new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), { status: 200 });
    };
    try {
      const client = new AiClient();
      await client.complete([{ role: "user", content: "test" }]);
      await client.complete([{ role: "user", content: "test" }]);
      assert.equal(captured[0]?.get("user-agent"), "ielts-self-study-demo/0.1.0");
      assert.ok(captured[0]?.get("x-opencode-session"));
      assert.equal(captured[0]?.get("x-opencode-session"), captured[1]?.get("x-opencode-session"));
    } finally {
      globalThis.fetch = originalFetch;
      keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
    }
  });

  it("rejects empty, unknown, duplicate, incomplete-baseline, and over-budget AI plans", () => {
    const input = planningInput();
    input.profile = { ...input.profile, dailyMinutes: 15 };
    assert.throws(() => validatePlan({ tasks: [] }, input), /没有安排可执行/);
    assert.throws(() => validatePlan({ tasks: [{ unitId: "missing", reason: "练习" }] }, input), /无效或未加载/);
    assert.throws(() => validatePlan({ tasks: [{ unitId: "unit-reading", reason: "" }] }, input), /安排理由/);
    assert.throws(() => validatePlan({ tasks: [{ unitId: "unit-reading", reason: "建立阅读基线" }] }, input), /没有为证据不足的科目安排基线/);
    assert.throws(() => validatePlan({ tasks: [
      { unitId: "unit-reading", reason: "建立阅读基线" },
      { unitId: "unit-listening", reason: "建立听力基线" },
    ] }, input), /超过每日/);
    const both = validatePlan({ tasks: [
      { unitId: "unit-reading", reason: "建立阅读基线" },
      { unitId: "unit-listening", reason: "建立听力基线" },
    ] }, { ...input, profile: { ...input.profile, dailyMinutes: 30 } });
    assert.equal(both.every((task) => task.date === input.today), true);
    assert.deepEqual(both.map((task) => task.questionIds), [["listening-q1"], ["reading-q1"]]);
    assert.throws(() => validatePlan({ tasks: [
      { unitId: "unit-reading", reason: "建立阅读基线" },
      { unitId: "unit-reading", reason: "重复" },
      { unitId: "unit-listening", reason: "建立听力基线" },
    ] }, { ...input, profile: { ...input.profile, dailyMinutes: 30 } }), /重复安排/);
  });

  it("surfaces missing AI configuration, invalid output, timeout, and missing material", async () => {
    const keys = ["IELTS_AI_BASE_URL", "IELTS_AI_MODEL", "IELTS_AI_API_KEY"] as const;
    const previous = keys.map((key) => process.env[key]);
    for (const key of keys) delete process.env[key];
    try { await assert.rejects(new AiClient().complete([{ role: "user", content: "plan" }]), /尚未配置/); }
    finally { keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; }); }

    const input = planningInput();
    const invalid = new AiClient();
    invalid.complete = async () => "not-json";
    await assert.rejects(new AiPlanner(invalid).generate(input), /格式无法识别/);

    const timeout = new AiClient();
    timeout.complete = async () => { throw new Error("AI 回复超时"); };
    await assert.rejects(new AiPlanner(timeout).generate(input), /超时/);

    await assert.rejects(new AiPlanner(invalid).generate({ ...input, units: [] }), /没有可安排的小题组/);
  });

  it("rechecks proposal time against locked tasks before applying", () => {
    const today = store.today();
    const locked = planTask("locked-budget", today, "reading-part-1", { locked: true, minutes: 25 });
    const proposed = planTask("new-budget", today, "listening-part-1", { minutes: 10 });
    assert.equal(fitsDailyBudget([proposed], [locked], 30), false);
    assert.equal(fitsDailyBudget([proposed], [locked], 45), true);
  });

  it("uses only server-provided due review candidates and their exact question groups", () => {
    const input = planningInput();
    input.requiredBaselineSections = [];
    input.units.unshift({ ...input.units[0]!, id: "due-review-unit", taskKind: "review", novelty: "review", questionIds: ["due-q1", "due-q2"], dueReviewQuestionIds: ["due-q1"], questionCount: 2, minutes: 4 });
    const tasks = validatePlan({ tasks: [{ unitId: "due-review-unit", reason: "按期复习这组到期题。" }] }, input);
    assert.equal(tasks[0]?.kind, "review");
    assert.deepEqual(tasks[0]?.questionIds, ["due-q1", "due-q2"]);
    assert.deepEqual(tasks[0]?.reviewQuestionIds, ["due-q1"]);
    assert.equal(tasks[0]?.minutes, 4);
  });

  it("summarizes plan additions, removals, and reason updates", () => {
    const today = store.today();
    const current = [planTask("old", today, "reading-part-1")];
    const updated = planTask("new", today, "reading-part-1", { reason: "根据最近证据调整。" });
    const added = planTask("added", today, "listening-part-1");
    const changes = diffPlan(current, [updated, added]);
    assert.deepEqual(changes.map((item) => item.kind).sort(), ["added", "updated"]);
    assert.equal(diffPlan(current, []).some((item) => item.kind === "removed"), true);
  });

  it("loads independent plugins and exposes sanitized browser entries", async () => {
    const registry = new PluginRegistry(join(process.cwd(), "plugins"));
    await registry.loadAll();
    const browserPlugins = registry.manifestsForBrowser();
    assert.ok(browserPlugins.some((plugin) => plugin.id === "reading"));
    assert.ok(browserPlugins.some((plugin) => plugin.id === "listening"));
    assert.deepEqual(Object.keys(browserPlugins[0]!).sort(), ["browserUrl", "id", "section"]);
    assert.match((await registry.readBrowserEntry("reading")).toString("utf8"), /mountPractice/);
    await registry.releaseAll();
  });
});

describe("hardening regressions", () => {
  it("keeps question and passage bodies out of the bootstrap catalog", async () => {
    const activity = readingPart(1, 3);
    activity.id = "catalog-light";
    activity.passage = { title: "Passage", text: "UNIQUE-PASSAGE-BODY" };
    activity.questions[0]!.prompt = "UNIQUE-QUESTION-PROMPT";
    const app = await createApp({ dataDirectory: join(directory, "catalog"), pluginDirectory: join(process.cwd(), "plugins"), activities: [activity], deferStartupPlanning: true });
    try {
      const dispatch = dispatcher(app);
      const boot = await dispatch("GET", "/api/bootstrap");
      assert.equal(boot.status, 200);
      const body = JSON.stringify(boot.json);
      assert.equal(body.includes("UNIQUE-PASSAGE-BODY"), false);
      assert.equal(body.includes("UNIQUE-QUESTION-PROMPT"), false);
      const summary = (boot.json.activities as Array<Record<string, unknown>>).find((item) => item.id === "catalog-light");
      assert.equal(summary?.questionCount, 3);
      assert.equal("questions" in (summary ?? {}), false);
      const started = await dispatch("POST", "/api/attempts", { activityId: activity.id, mode: "practice" });
      assert.equal(started.status, 201);
      assert.equal(JSON.stringify(started.json).includes("UNIQUE-QUESTION-PROMPT"), true);
      assert.equal(JSON.stringify(started.json).includes("UNIQUE-PASSAGE-BODY"), true);
    } finally { await app.close(); }
  });

  it("filters invalid and duplicate activities from the cloud catalog", async () => {
    const activity = readingPart(1, 1);
    activity.id = "cloud-valid";
    const rows = [
      { activity_json: JSON.stringify(activity) },
      { activity_json: JSON.stringify({ id: "broken" }) },
      { activity_json: JSON.stringify(activity) },
      { activity_json: "{not-json" },
    ];
    const client = { query: async (sql: string) => sql.includes("FROM imported_activities") ? { rows } : { rows: [] } };
    const cloud = new PostgresLearningStore(client as never);
    assert.deepEqual((await cloud.importedActivities()).map((item) => item.id), ["cloud-valid"]);
    await assert.rejects(() => cloud.importActivities([{ id: "broken" } as never]), /插件 ID 无效/);
  });

  it("keeps cloud draft writes monotonic and reports ended drafts", async () => {
    const queries: string[] = [];
    const row = {
      id: "attempt-1", activity_id: "reading-part-1", mode: "practice", answers_json: "{}", hinted_json: "[]",
      started_at: "2026-10-22T00:00:00.000Z", updated_at: "2026-10-22T00:00:00.000Z", status: "in_progress",
      review_question_ids_json: "[]", question_ids_json: "[]", question_time_seconds_json: "{}", client_revision: "101",
    };
    let found = true;
    const client = { query: async (sql: string) => {
      queries.push(sql);
      if (sql.startsWith("UPDATE drafts")) return { rows: [], rowCount: 0 };
      if (sql.includes("FROM drafts")) return { rows: found ? [row] : [] };
      return { rows: [] };
    } };
    const cloud = new PostgresLearningStore(client as never);
    const saved = await cloud.saveDraft("attempt-1", {}, {}, 100);
    assert.equal(saved.saveRevision, 101);
    assert.ok(queries.some((sql) => sql.includes("draft.client_revision < $3")));
    found = false;
    await assert.rejects(() => cloud.saveDraft("attempt-1", {}, {}, 102), (error: unknown) => error instanceof StoreError && error.status === 409);
    await assert.rejects(() => cloud.abandonAttempt("missing"), (error: unknown) => error instanceof StoreError && error.status === 404);
  });

  it("returns historical plan tasks and applies proposals only once", () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    store.savePlan([planTask("history-task", yesterday, "reading-part-1")], "history");
    const updated = store.setPlanTask("history-task", { locked: true });
    assert.equal(updated?.id, "history-task");
    assert.equal(updated?.locked, true);
    assert.equal(store.plan().some((item) => item.id === "history-task"), false);

    const today = store.today();
    const proposal = store.beginPlanProposal("proposal-once");
    const task = planTask("proposal-task", today, "reading-part-1");
    assert.equal(store.completePlanProposal(proposal, [task], [{ kind: "added", after: task }]), true);
    assert.equal(store.applyPlanProposal(proposal), true);
    assert.equal(store.applyPlanProposal(proposal), false);
  });

  it("starts plan generation only when the day is idle", () => {
    const today = store.today();
    const first = store.beginPlanProposalIfIdle("rev-1", today);
    assert.ok(first);
    assert.equal(store.beginPlanProposalIfIdle("rev-2", today), undefined);
    assert.equal(store.completePlanProposal(first!, [], []), true);
    assert.equal(store.beginPlanProposalIfIdle("rev-3", today), undefined);

    const failed = store.beginPlanProposal("rev-failed");
    store.failPlanProposal(failed, "模型超时");
    assert.equal(store.beginPlanProposalIfIdle("rev-4", today), undefined);
    assert.ok(store.beginPlanProposalIfIdle("rev-5", today, { retryFailed: true }));

    store.database.prepare("UPDATE plan_proposals SET updated_at=? WHERE singleton=1").run("2020-01-01T00:00:00.000Z");
    assert.equal(store.beginPlanProposalIfIdle("rev-6", today), undefined);
    assert.ok(store.beginPlanProposalIfIdle("rev-7", today, { recoverStaleBefore: new Date().toISOString() }));
    assert.ok(store.beginPlanProposalIfIdle("rev-8", "2099-01-01"));
  });

  it("rejects a review that mixes in questions that are not due", async () => {
    const activity = readingPart(1, 2);
    activity.id = "review-mixed";
    const app = await createApp({ dataDirectory: join(directory, "review-mixed"), pluginDirectory: join(process.cwd(), "plugins"), activities: [activity] });
    try {
      const local = app.store as LearningStore;
      const [dueQuestion, futureQuestion] = activity.questions;
      local.database.prepare("INSERT INTO review_schedule (question_id, activity_id, plugin_id, streak, interval_days, due_date, last_result, last_seen) VALUES (?, ?, ?, 0, 1, ?, 'incorrect', ?)")
        .run(dueQuestion!.id, activity.id, "reading", await app.store.today(), new Date().toISOString());
      const dispatch = dispatcher(app);
      const mixed = await dispatch("POST", "/api/attempts", { activityId: activity.id, mode: "review", reviewQuestionIds: [dueQuestion!.id, futureQuestion!.id] });
      assert.equal(mixed.status, 400);
      const valid = await dispatch("POST", "/api/attempts", { activityId: activity.id, mode: "review", reviewQuestionIds: [dueQuestion!.id] });
      assert.equal(valid.status, 201);
    } finally { await app.close(); }
  });

  it("isolates the tutor during a mock and reopens it after submission", async () => {
    const activities = [readingPart(1, 14), readingPart(2, 13), readingPart(3, 13)];
    const ai = new AiClient();
    ai.missingSettings = () => [];
    let calls = 0;
    let lastSnapshot = "";
    ai.complete = async (messages) => { calls++; lastSnapshot = messages[1]?.content ?? ""; return "先看题干里的关键词。"; };
    const app = await createApp({ dataDirectory: join(directory, "coach-isolation"), pluginDirectory: join(process.cwd(), "plugins"), activities, aiClient: ai, deferStartupPlanning: true });
    try {
      const dispatch = dispatcher(app);
      const prepared = await dispatch("POST", "/api/mock/prepare", { section: "reading" });
      const paper = prepared.json.activity as Activity;
      const started = await dispatch("POST", "/api/mock/start", { section: "reading", mockId: paper.mockId });
      assert.equal(started.status, 201);
      const mock = started.json as unknown as { draft: { attemptId: string }; activity: { id: string; questions: Array<{ id: string }> } };
      const activityId = mock.activity.id;
      const questionId = mock.activity.questions[0]!.id;

      assert.equal((await dispatch("POST", "/api/coach", { conversationId: "coach-during", activityId, questionId, message: "给我答案" })).status, 403);
      assert.equal(calls, 0);

      const practice = await dispatch("POST", "/api/attempts", { activityId: "reading-part-1", mode: "practice" });
      assert.equal(practice.status, 201);
      const practiceAttemptId = (practice.json as unknown as { draft: { attemptId: string } }).draft.attemptId;
      assert.equal((await dispatch("POST", "/api/coach", { conversationId: "coach-borrowed", activityId, questionId, attemptId: practiceAttemptId, message: "继续" })).status, 403);
      assert.equal(calls, 0);

      assert.equal((await dispatch("POST", `/api/attempts/${mock.draft.attemptId}/submit`, {})).status, 200);
      const after = await dispatch("POST", "/api/coach", { conversationId: "coach-after", activityId, questionId, attemptId: mock.draft.attemptId, message: "为什么？" });
      assert.equal(after.status, 200);
      assert.equal(calls, 1);
      assert.match(lastSnapshot, /submittedResponse/);
      assert.match(lastSnapshot, /A paragraph/);

      assert.equal((await dispatch("POST", "/api/coach", { conversationId: "coach-no-attempt", activityId, questionId, message: "再来" })).status, 403);
      assert.equal(calls, 1);

      const normal = await dispatch("POST", "/api/coach", { conversationId: "coach-practice", activityId: "reading-part-1", questionId: "reading-q-1-0", attemptId: practiceAttemptId, message: "提示" });
      assert.equal(normal.status, 200);
      assert.equal(calls, 2);
    } finally { await app.close(); }
  });

  it("keeps unknown fields out of the public activity DTO", () => {
    const activity = readingPart(1, 1);
    (activity as unknown as Record<string, unknown>).answerKey = "SECRET-KEY";
    (activity.questions[0] as unknown as Record<string, unknown>).internalRationale = "SECRET-NOTE";
    const publicValue = toPublicActivity(activity);
    assert.equal("answerKey" in publicValue, false);
    assert.equal("internalRationale" in publicValue.questions[0]!, false);
    assert.equal(JSON.stringify(publicValue).includes("SECRET"), false);
    assert.equal(publicValue.questions[0]!.skillTags[0], "reading.evidence");
  });

  it("preserves HTTP status and only redirects auth failures to login", async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () => new Response(JSON.stringify({ error: "gone" }), { status: 404 });
      await assert.rejects(api.resumeAttempt("x"), (error: unknown) => error instanceof ApiError && error.status === 404 && error.message === "gone");
      globalThis.fetch = async () => new Response(JSON.stringify({ error: "bad" }), { status: 500 });
      await assert.rejects(api.bootstrap(), (error: unknown) => error instanceof ApiError && error.status === 500);

      let unauthorized = 0;
      setUnauthorizedHandler(() => { unauthorized++; });
      globalThis.fetch = async () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
      await assert.rejects(api.bootstrap(), (error: unknown) => error instanceof ApiError && error.status === 401);
      assert.equal(unauthorized, 1);
      await assert.rejects(api.authSession(), (error: unknown) => error instanceof ApiError && error.status === 401);
      assert.equal(unauthorized, 1);

      globalThis.fetch = async () => { throw new TypeError("network"); };
      await assert.rejects(api.bootstrap(), (error: unknown) => error instanceof Error && !(error instanceof ApiError) && /连接失败/.test(error.message));
    } finally {
      globalThis.fetch = originalFetch;
      setUnauthorizedHandler(undefined);
    }
  });

  it("anchors exam time to the server and ignores later system-clock changes", async () => {
    const originalFetch = globalThis.fetch;
    const originalNow = Date.now;
    const timestamp = originalNow() + 3_600_000;
    try {
      globalThis.fetch = async () => new Response("{}", { headers: { "x-server-time": String(timestamp) } });
      await api.bootstrap();
      assert.ok(Math.abs(api.serverNow() - timestamp) < 1000);
      Date.now = () => originalNow() - 86_400_000;
      assert.ok(Math.abs(api.serverNow() - timestamp) < 1000);
    } finally {
      Date.now = originalNow;
      globalThis.fetch = async () => new Response("{}", { headers: { "x-server-time": String(originalNow()) } });
      await api.bootstrap();
      globalThis.fetch = originalFetch;
    }
  });

  it("does not crash when a media stream fails after headers", async () => {
    const failing = "11111111-1111-4111-8111-111111111111.mp3";
    const healthy = "22222222-2222-4222-8222-222222222222.mp3";
    const app = await createApp({
      dataDirectory: join(directory, "stream"),
      pluginDirectory: join(process.cwd(), "plugins"),
      activities: [],
      deferStartupPlanning: true,
      mediaReader: async (pathname, range) => ({
        stream: pathname === failing
          ? Readable.from((async function* () { yield Buffer.from("ab"); throw new Error("blob stream failed"); })())
          : Readable.from([Buffer.from("abcd")]),
        size: 4,
        contentType: "audio/mpeg",
        status: range ? 206 : 200,
        headers: (range ? { "content-range": "bytes 0-3/4" } : {}) as Record<string, string>,
      }),
    });
    try {
      const request = (pathname: string) => ({ url: `/api/media/${pathname}`, method: "GET", headers: { host: "127.0.0.1", range: "bytes=0-3" }, async *[Symbol.asyncIterator]() {} }) as unknown as IncomingMessage;
      const broken = createSink();
      await app.handle(request(failing), broken as unknown as ServerResponse);
      assert.equal(broken.status, 206);
      assert.equal(broken.destroyed, true);

      const ok = createSink();
      await app.handle(request(healthy), ok as unknown as ServerResponse);
      assert.equal(ok.status, 206);
      assert.equal(Buffer.concat(ok.chunks).toString(), "abcd");
    } finally { await app.close(); }
  });
});
