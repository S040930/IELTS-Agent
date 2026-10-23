import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Activity, AnswerDraft, AttemptResult, PublicActivity } from "../src/shared/domain.js";
import { createApp } from "../server/index.js";
import { LearningStore } from "../server/db.js";
import { PostgresLearningStore } from "../server/postgres-store.js";
import { composeMock, listCompleteMocks, mockTiming } from "../server/services/mock-sets.js";
import { toPublicActivity } from "../server/plugins/registry.js";
// @ts-expect-error shared browser module is plain ESM
import { listeningPosition } from "../plugins/shared/mock-audio.mjs";

function materials(section: "reading" | "listening"): Activity[] {
  return (section === "reading" ? [13, 13, 14] : [10, 10, 10, 10]).map((count, index) => ({
    id: `${section}-${index + 1}`, pluginId: section, part: (index + 1) as Activity["part"],
    title: `Material ${index + 1}`, description: "Test material", minutes: 8, difficulty: 2, sample: false,
    ...(section === "reading" ? { passage: { title: `Article ${index + 1}`, text: "The evidence supports the answer." } }
      : { audioUrl: `/media/part-${index + 1}.mp3`, transcript: "A private recording transcript." }),
    questions: Array.from({ length: count }, (_, number) => ({
      id: `${section}-${index + 1}-q${number + 1}`, prompt: "Choose the supported answer.", kind: "choice" as const,
      options: ["A", "B"], correctAnswer: "A", evidence: "Private evidence.", explanation: "Private explanation.",
      skillTags: [`${section}.detail`], groupId: `${section}-${index + 1}-group`,
    })),
  }));
}

function dispatch(app: Awaited<ReturnType<typeof createApp>>) {
  return async <T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> => {
    let status = 200; let text = "";
    const req = { method, url: path, headers: { host: "127.0.0.1", "content-type": "application/json" }, async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)); } } as unknown as IncomingMessage;
    const res = { headersSent: false, writeHead(code: number) { status = code; return res; }, end(value: string) { text = value; } } as unknown as ServerResponse;
    try { await app.handle(req, res); }
    catch (reason) { status = Number((reason as { status?: number }).status ?? 500); text = JSON.stringify({ error: String(reason) }); }
    return { status, body: JSON.parse(text || "{}") as T };
  };
}

describe("computer mock lifecycle", () => {
  it("composes ordered complete parts without changing source questions or splitting groups", () => {
    for (const section of ["reading", "listening"] as const) {
      const source = materials(section);
      const original = JSON.stringify(source);
      const paper = composeMock(section, "test-paper", source)!;
      assert.equal(paper.questions.length, 40);
      assert.deepEqual(paper.questions.map((question) => question.displayNumber), Array.from({ length: 40 }, (_, index) => index + 1));
      assert.deepEqual(paper.examParts!.map((part) => part.sourceActivityId), source.map((activity) => activity.id));
      assert.equal(JSON.stringify(source), original);
      assert.equal(new Set(paper.questions.map((question) => question.id)).size, 40);
    }
  });

  it("excludes paper-transfer instructions and reports unavailable sections", () => {
    const source = materials("listening");
    source[0]!.transcript = "At the end you will have ten minutes to transfer your answers to an answer sheet.";
    assert.equal(listCompleteMocks(source).find((item) => item.section === "listening")!.ready, false);
    assert.equal(composeMock("listening", "bad-paper", source), undefined);
    assert.equal(composeMock("reading", "missing", materials("reading").slice(0, 2)), undefined);
    assert.equal(composeMock("reading", "wrong-size", materials("reading").map((part) => ({ ...part, questions: part.questions.slice(0, 12) }))), undefined);
  });

  it("whitelists nested part metadata instead of leaking private or unknown fields", () => {
    const paper = composeMock("listening", "privacy-test", materials("listening"))!;
    Object.assign(paper.examParts![0]!, { transcript: "Private text", correctAnswer: "Secret", internal: { answer: "Hidden" } });
    const value = JSON.stringify(toPublicActivity(paper));
    assert.equal(/Private|Secret|Hidden|internal|transcript|correctAnswer/.test(value), false);
    assert.equal(toPublicActivity(paper).examParts![0]!.sourceActivityId, "listening-1");
  });

  it("prepares without starting a timer, persists its snapshot, grades once and reviews original materials", async () => {
    const folder = await mkdtemp(join(tmpdir(), "ielts-exam-test-"));
    const source = materials("reading");
    const app = await createApp({ dataDirectory: folder, activities: source, deferStartupPlanning: true });
    try {
      const send = dispatch(app);
      const prepared = await send<{ activity: PublicActivity }>("POST", "/api/mock/prepare", { section: "reading" });
      assert.equal(prepared.status, 201);
      const paper = prepared.body.activity;
      assert.equal((app.store as LearningStore).database.prepare("SELECT COUNT(*) AS count FROM drafts").get()!.count, 0);
      assert.equal(/correctAnswer|Private evidence|Private explanation|transcript/.test(JSON.stringify(paper)), false);
      assert.equal(paper.examParts!.length, 3);
      source[0]!.questions[0]!.correctAnswer = "B";
      const started = await send<{ draft: AnswerDraft; activity: PublicActivity }>("POST", "/api/mock/start", { section: "reading", mockId: paper.mockId });
      assert.equal(started.status, 201);
      const draft = started.body.draft;
      assert.equal(Date.parse(draft.deadlineAt!) - Date.parse(draft.startedAt), 3600000);
      assert.equal(started.body.activity.minutes, 60);
      const answers = { [paper.questions[0]!.id]: "A" };
      await send("PATCH", `/api/attempts/${draft.attemptId}/draft`, { answers, revision: 1 });
      const resumed = await send<{ draft: AnswerDraft; activity: PublicActivity }>("GET", `/api/attempts/${draft.attemptId}`);
      assert.equal(resumed.body.draft.deadlineAt, draft.deadlineAt);
      assert.deepEqual(resumed.body.activity, started.body.activity);
      const result = await send<{ result: AttemptResult }>("POST", `/api/attempts/${draft.attemptId}/submit`, { answers });
      assert.equal(result.status, 200);
      assert.equal(result.body.result.score, 1);
      assert.equal(result.body.result.responses[0]!.materialId, "reading-1");
      const duplicate = await send<{ result: AttemptResult }>("POST", `/api/attempts/${draft.attemptId}/submit`, { answers: {} });
      assert.equal(duplicate.body.result.submittedAt, result.body.result.submittedAt);
      assert.equal(duplicate.body.result.score, 1);
      const rows = (app.store as LearningStore).database.prepare("SELECT DISTINCT activity_id FROM review_schedule").all();
      assert.deepEqual(rows.map((row) => row.activity_id).sort(), ["reading-1", "reading-2", "reading-3"]);
      const completed = await send<{ result: AttemptResult; activity: PublicActivity }>("GET", `/api/attempts/${draft.attemptId}`);
      assert.equal(completed.body.result.deadlineAt, draft.deadlineAt);
      assert.deepEqual(completed.body.activity, paper);
      // A new repository connection reads the same immutable paper, not a random replacement.
      const reopened = new LearningStore(join(folder, "learning.sqlite"));
      try { assert.equal(reopened.mockPaper(paper.id)!.questions[0]!.correctAnswer, "A"); }
      finally { reopened.close(); }
    } finally { await app.close(); await rm(folder, { recursive: true, force: true }); }
  });

  it("requires listening preflight and restores a fixed recording timeline without exposing transcripts", async () => {
    const folder = await mkdtemp(join(tmpdir(), "ielts-listening-test-"));
    const app = await createApp({ dataDirectory: folder, activities: materials("listening"), deferStartupPlanning: true });
    try {
      const send = dispatch(app);
      const prepared = await send<{ activity: PublicActivity }>("POST", "/api/mock/prepare", { section: "listening" });
      const paper = prepared.body.activity;
      assert.equal(/transcript|Private/.test(JSON.stringify(paper)), false);
      assert.equal((await send("POST", "/api/mock/start", { section: "listening", mockId: paper.mockId })).status, 400);
      const started = await send<{ draft: AnswerDraft }>("POST", "/api/mock/start", { section: "listening", mockId: paper.mockId, audioDurationsSeconds: [4, 5, 6, 7] });
      assert.equal(started.status, 201);
      const draft = started.body.draft;
      assert.equal(draft.examTiming!.durationSeconds, 142);
      assert.equal(Date.parse(draft.deadlineAt!) - Date.parse(draft.startedAt), 142000);
      assert.equal((await send("GET", `/api/attempts/${draft.attemptId}/transcript`)).status, 403);
      const resumed = await send<{ draft: AnswerDraft }>("GET", `/api/attempts/${draft.attemptId}`);
      assert.deepEqual(resumed.body.draft.examTiming, draft.examTiming);
      assert.equal(resumed.body.draft.deadlineAt, draft.deadlineAt);
      assert.throws(() => mockTiming(materials("listening")[0]!, [0, 1, 2, 3]));
    } finally { await app.close(); await rm(folder, { recursive: true, force: true }); }
  });

  it("moves recordings and enters exactly two minutes of checking using wall time", () => {
    const start = "2026-10-23T00:00:00.000Z";
    const at = (seconds: number) => listeningPosition(start, [10, 20, 30, 40], Date.parse(start) + seconds * 1000);
    assert.deepEqual(at(0), { index: 0, offset: 0, checking: false, remaining: 0 });
    assert.deepEqual(at(12), { index: 1, offset: 2, checking: false, remaining: 0 });
    assert.deepEqual(at(95), { index: 3, offset: 35, checking: false, remaining: 0 });
    assert.deepEqual(at(100), { index: 4, offset: 0, checking: true, remaining: 120 });
    assert.equal(at(219).remaining, 1);
    assert.equal(at(220).remaining, 0);
    assert.equal(at(900).remaining, 0);
  });

  it("persists complete papers through the Neon repository contract", async () => {
    let saved: unknown[] = [];
    const client = { query: async (sql: string, values: unknown[]) => {
      if (sql.startsWith("INSERT INTO mock_papers")) { saved = values; return { rows: [], rowCount: 1 }; }
      if (sql.startsWith("SELECT activity_json FROM mock_papers")) return { rows: values[0] === saved[0] ? [{ activity_json: saved[1] }] : [], rowCount: 1 };
      throw new Error(`Unexpected SQL: ${sql}`);
    } };
    const cloud = new PostgresLearningStore(client as never);
    const paper = composeMock("reading", "cloud-paper", materials("reading"))!;
    await cloud.saveMockPaper(paper);
    assert.deepEqual(await cloud.mockPaper(paper.id), paper);
    assert.equal(await cloud.mockPaper("missing"), undefined);
  });
});
