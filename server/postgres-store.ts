import { randomUUID } from "node:crypto";
import type { Client } from "@neondatabase/serverless";
import type {
  Activity, ActivityMode, AnswerDraft, AttemptResult, CoachMessage, LearnerProfile, PlanProposal,
  PlanProposalChange, PlanTask, QuestionResult, Section, SkillEvidence,
} from "../src/shared/domain.js";
import type { LearningRepository } from "./store-contract.js";
import { StoreError } from "./store-error.js";
import { examDeadline, type ExamTiming } from "../src/shared/domain.js";
import { assertActivity } from "../src/shared/validation.js";

type Row = Record<string, unknown>;
type QueryClient = Pick<Client, "query">;
const now = () => new Date().toISOString();
const parse = <T>(value: unknown, fallback: T): T => {
  if (typeof value !== "string") return (value as T | null | undefined) ?? fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
};
const bool = (value: unknown) => value === true || value === 1 || value === "1";

export class PostgresLearningStore implements LearningRepository {
  constructor(private readonly client: QueryClient) {}

  async initialize(): Promise<void> {
    const schema = `
      CREATE TABLE IF NOT EXISTS profile (
        id TEXT PRIMARY KEY, target_listening DOUBLE PRECISION NOT NULL, target_reading DOUBLE PRECISION NOT NULL,
        exam_date TEXT NOT NULL, daily_minutes INTEGER NOT NULL, updated_at TEXT NOT NULL,
        setup_complete BOOLEAN NOT NULL DEFAULT FALSE
      );
      CREATE TABLE IF NOT EXISTS imported_activities (
        id TEXT PRIMARY KEY, plugin_id TEXT NOT NULL, activity_json TEXT NOT NULL, imported_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS media_assets (
        pathname TEXT PRIMARY KEY, content_type TEXT NOT NULL, size_bytes BIGINT NOT NULL, sha256 TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS drafts (
        id TEXT PRIMARY KEY, activity_id TEXT NOT NULL, mode TEXT NOT NULL, answers_json TEXT NOT NULL,
        hinted_json TEXT NOT NULL, started_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        status TEXT NOT NULL, interruption TEXT, task_id TEXT, review_question_ids_json TEXT NOT NULL DEFAULT '[]',
        question_ids_json TEXT NOT NULL DEFAULT '[]', question_time_seconds_json TEXT NOT NULL DEFAULT '{}',
        client_revision BIGINT NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS attempts (
        id TEXT PRIMARY KEY, activity_id TEXT NOT NULL, plugin_id TEXT NOT NULL, mode TEXT NOT NULL,
        answers_json TEXT NOT NULL, hinted_json TEXT NOT NULL, started_at TEXT NOT NULL,
        submitted_at TEXT NOT NULL, score INTEGER NOT NULL, total INTEGER NOT NULL,
        responses_json TEXT NOT NULL, sample BOOLEAN NOT NULL, question_time_seconds_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS causes (
        id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL, question_id TEXT NOT NULL,
        skill_tag TEXT NOT NULL, cause TEXT NOT NULL, confirmed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mock_papers (
        id TEXT PRIMARY KEY, activity_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS review_schedule (
        question_id TEXT PRIMARY KEY, activity_id TEXT NOT NULL, plugin_id TEXT NOT NULL,
        streak INTEGER NOT NULL, interval_days INTEGER NOT NULL, due_date TEXT NOT NULL,
        last_result TEXT NOT NULL, last_seen TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS plan_tasks (
        id TEXT PRIMARY KEY, date TEXT NOT NULL, activity_id TEXT NOT NULL, plugin_id TEXT NOT NULL,
        kind TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL, minutes INTEGER NOT NULL,
        reason TEXT NOT NULL, review_question_ids_json TEXT NOT NULL DEFAULT '[]', question_ids_json TEXT NOT NULL DEFAULT '[]',
        focus_skill_tag TEXT, question_kind TEXT, locked BOOLEAN NOT NULL DEFAULT FALSE,
        status TEXT NOT NULL DEFAULT 'pending', revision TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS plan_proposals (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1), id TEXT NOT NULL, status TEXT NOT NULL,
        input_revision TEXT NOT NULL, tasks_json TEXT NOT NULL, changes_json TEXT NOT NULL, error TEXT, updated_at TEXT NOT NULL,
        plan_date TEXT
      );
      CREATE TABLE IF NOT EXISTS coach_messages (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL,
        text TEXT NOT NULL, created_at TEXT NOT NULL, question_id TEXT
      );
      CREATE TABLE IF NOT EXISTS demo_login_attempts (
        source_hash TEXT PRIMARY KEY, failed_at TIMESTAMPTZ[] NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS coach_messages_recent ON coach_messages(conversation_id, created_at);
      CREATE INDEX IF NOT EXISTS plan_by_date ON plan_tasks(date, status);
      CREATE INDEX IF NOT EXISTS attempts_recent ON attempts(submitted_at);
      CREATE INDEX IF NOT EXISTS reviews_by_due_date ON review_schedule(due_date);
    `;
    for (const statement of schema.split(";").map((item) => item.trim()).filter(Boolean)) await this.client.query(statement);
    for (const statement of [
      "ALTER TABLE drafts ADD COLUMN IF NOT EXISTS question_ids_json TEXT NOT NULL DEFAULT '[]'",
      "ALTER TABLE drafts ADD COLUMN IF NOT EXISTS question_time_seconds_json TEXT NOT NULL DEFAULT '{}'",
      "ALTER TABLE drafts ADD COLUMN IF NOT EXISTS client_revision BIGINT NOT NULL DEFAULT 0",
      "ALTER TABLE attempts ADD COLUMN IF NOT EXISTS question_time_seconds_json TEXT NOT NULL DEFAULT '{}'",
      "ALTER TABLE drafts ADD COLUMN IF NOT EXISTS exam_timing_json TEXT",
      "ALTER TABLE attempts ADD COLUMN IF NOT EXISTS exam_timing_json TEXT",
      "ALTER TABLE plan_tasks ADD COLUMN IF NOT EXISTS question_ids_json TEXT NOT NULL DEFAULT '[]'",
      "ALTER TABLE plan_tasks ADD COLUMN IF NOT EXISTS focus_skill_tag TEXT",
      "ALTER TABLE plan_tasks ADD COLUMN IF NOT EXISTS question_kind TEXT",
      "ALTER TABLE plan_proposals ADD COLUMN IF NOT EXISTS plan_date TEXT",
    ]) await this.client.query(statement);
    await this.client.query("UPDATE plan_tasks SET status='expired' WHERE status='pending' AND question_ids_json='[]'");
    const examDate = new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10);
    await this.client.query(`INSERT INTO profile
      (id, target_listening, target_reading, exam_date, daily_minutes, updated_at, setup_complete)
      VALUES ('local-learner', 7, 7, $1, 45, $2, FALSE) ON CONFLICT (id) DO NOTHING`, [examDate, now()]);
  }

  private async rows(sql: string, params: unknown[] = []): Promise<Row[]> {
    return (await this.client.query(sql, params)).rows as Row[];
  }
  private async one(sql: string, params: unknown[] = []): Promise<Row | undefined> { return (await this.rows(sql, params))[0]; }
  private examDate(): string { return new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10); }
  private profileFrom(row: Row): LearnerProfile {
    return { id: String(row.id), targetListening: Number(row.target_listening), targetReading: Number(row.target_reading), examDate: String(row.exam_date), dailyMinutes: Number(row.daily_minutes), updatedAt: String(row.updated_at), setupComplete: bool(row.setup_complete) };
  }
  async profile(): Promise<LearnerProfile> {
    const row = await this.one("SELECT * FROM profile WHERE id='local-learner'");
    if (!row) throw new Error("学习档案尚未初始化。");
    return this.profileFrom(row);
  }
  async saveProfile(input: Pick<LearnerProfile, "targetListening" | "targetReading" | "examDate" | "dailyMinutes">): Promise<LearnerProfile> {
    await this.client.query(`UPDATE profile SET target_listening=$1, target_reading=$2, exam_date=$3, daily_minutes=$4, updated_at=$5, setup_complete=TRUE WHERE id='local-learner'`, [input.targetListening, input.targetReading, input.examDate, input.dailyMinutes, now()]);
    return this.profile();
  }
  async importedActivities(): Promise<Activity[]> {
    const activities: Activity[] = [];
    const seen = new Set<string>();
    for (const row of await this.rows("SELECT activity_json FROM imported_activities ORDER BY imported_at DESC")) {
      try {
        const candidate: unknown = JSON.parse(String(row.activity_json));
        assertActivity(candidate);
        if (seen.has(candidate.id)) continue;
        seen.add(candidate.id);
        activities.push(candidate);
      } catch (error) {
        console.error(`[content-catalog] skipped invalid imported activity: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return activities;
  }
  async importActivities(activities: Activity[]): Promise<number> {
    for (const activity of activities) assertActivity(activity);
    await this.client.query("BEGIN");
    try {
      const importedAt = now();
      for (const activity of activities) await this.client.query(`INSERT INTO imported_activities (id, plugin_id, activity_json, imported_at)
        VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO UPDATE SET plugin_id=EXCLUDED.plugin_id, activity_json=EXCLUDED.activity_json, imported_at=EXCLUDED.imported_at`, [activity.id, activity.pluginId, JSON.stringify(activity), importedAt]);
      await this.client.query("COMMIT");
      return activities.length;
    } catch (error) { await this.client.query("ROLLBACK"); throw error; }
  }
  activityById(activities: Activity[], activityId: string): Activity | undefined { return activities.find((activity) => activity.id === activityId); }

  async saveMockPaper(activity: Activity): Promise<void> {
    await this.client.query("INSERT INTO mock_papers (id, activity_json, created_at) VALUES ($1, $2, $3)", [activity.id, JSON.stringify(activity), now()]);
  }

  async mockPaper(id: string): Promise<Activity | undefined> {
    const row = await this.one("SELECT activity_json FROM mock_papers WHERE id=$1", [id]);
    return row ? parse<Activity | undefined>(row.activity_json, undefined) : undefined;
  }

  private toDraft(row: Row): AnswerDraft {
    const examTiming = parse<ExamTiming | undefined>(row.exam_timing_json, undefined);
    const questionIds = parse(row.question_ids_json, [] as string[]);
    return { ...(examTiming ? { examTiming, deadlineAt: examDeadline(String(row.started_at), examTiming) } : {}), attemptId: String(row.id), activityId: String(row.activity_id), ...(row.task_id ? { taskId: String(row.task_id) } : {}), ...(questionIds.length ? { questionIds } : {}), reviewQuestionIds: parse(row.review_question_ids_json, [] as string[]), mode: row.mode as ActivityMode, answers: parse(row.answers_json, {} as Record<string, string>), questionTimeSeconds: parse(row.question_time_seconds_json, {} as Record<string, number>), saveRevision: Number(row.client_revision ?? 0), hintedQuestionIds: parse(row.hinted_json, [] as string[]), startedAt: String(row.started_at), updatedAt: String(row.updated_at), ...(row.interruption ? { interruption: String(row.interruption) } : {}) };
  }
  private toAttempt(row: Row): AttemptResult {
    const examTiming = parse<ExamTiming | undefined>(row.exam_timing_json, undefined);
    const responses = parse(row.responses_json, [] as QuestionResult[]);
    const questionIds = [...new Set(responses.map((response) => response.questionId))];
    const draft: AnswerDraft = { ...(examTiming ? { examTiming, deadlineAt: examDeadline(String(row.started_at), examTiming) } : {}), attemptId: String(row.id), activityId: String(row.activity_id), mode: row.mode as ActivityMode, ...(questionIds.length ? { questionIds } : {}), answers: parse(row.answers_json, {} as Record<string, string>), questionTimeSeconds: parse(row.question_time_seconds_json, {} as Record<string, number>), hintedQuestionIds: parse(row.hinted_json, [] as string[]), startedAt: String(row.started_at), updatedAt: String(row.submitted_at) };
    return { ...draft, pluginId: row.plugin_id as Section, submittedAt: String(row.submitted_at), score: Number(row.score), total: Number(row.total), responses, sample: bool(row.sample) };
  }
  async startAttempt(activityId: string, mode: ActivityMode, taskId?: string, reviewQuestionIds?: string[], questionIds?: string[], examTiming?: ExamTiming): Promise<AnswerDraft> {
    const timestamp = now(); const id = randomUUID();
    const selectedIds = questionIds ?? reviewQuestionIds ?? [];
    await this.client.query(`INSERT INTO drafts (id, activity_id, mode, answers_json, hinted_json, started_at, updated_at, status, interruption, task_id, review_question_ids_json, question_ids_json, question_time_seconds_json, exam_timing_json)
      VALUES ($1, $2, $3, '{}', '[]', $4, $4, 'in_progress', NULL, $5, $6, $7, '{}', $8)`, [id, activityId, mode, timestamp, taskId ?? null, JSON.stringify(reviewQuestionIds ?? []), JSON.stringify(selectedIds), examTiming ? JSON.stringify(examTiming) : null]);
    return { ...(examTiming ? { examTiming, deadlineAt: examDeadline(timestamp, examTiming) } : {}), attemptId: id, activityId, ...(taskId ? { taskId } : {}), ...(selectedIds.length ? { questionIds: selectedIds } : {}), ...(reviewQuestionIds?.length ? { reviewQuestionIds } : {}), mode, answers: {}, questionTimeSeconds: {}, saveRevision: 0, hintedQuestionIds: [], startedAt: timestamp, updatedAt: timestamp };
  }
  async draft(attemptId: string): Promise<AnswerDraft | undefined> {
    const row = await this.one("SELECT * FROM drafts WHERE id=$1 AND status='in_progress'", [attemptId]);
    return row ? this.toDraft(row) : undefined;
  }
  async draftForActivity(activityId: string): Promise<AnswerDraft | undefined> {
    const row = await this.one("SELECT * FROM drafts WHERE activity_id=$1 AND status='in_progress' ORDER BY updated_at DESC LIMIT 1", [activityId]);
    return row ? this.toDraft(row) : undefined;
  }
  async saveDraft(attemptId: string, answers: Record<string, string>, questionTimeSeconds: Record<string, number> | undefined, revision: number): Promise<AnswerDraft> {
    if (!Number.isSafeInteger(revision) || revision <= 0) throw new StoreError("草稿保存版本无效。", 409);
    for (const [key, value] of Object.entries(answers)) if (key.length > 64 || value.length > 1000) throw new Error("作答内容超出长度限制");
    const times = Object.fromEntries(Object.entries(questionTimeSeconds ?? {}).filter(([key, value]) => key.length <= 64 && Number.isFinite(value) && value >= 0 && value <= 86_400));
    await this.client.query(`UPDATE drafts AS draft SET answers_json=$1,
      question_time_seconds_json=(SELECT COALESCE(jsonb_object_agg(key, seconds), '{}'::jsonb)::text FROM (
        SELECT key, max(value::numeric) AS seconds FROM (
          SELECT key, value FROM jsonb_each_text(COALESCE(draft.question_time_seconds_json, '{}')::jsonb)
          UNION ALL SELECT key, value FROM jsonb_each_text($2::jsonb)
        ) AS combined GROUP BY key
      ) AS merged), client_revision=$3, updated_at=$4 WHERE id=$5 AND status='in_progress' AND draft.client_revision < $3`, [JSON.stringify(answers), JSON.stringify(times), revision, now(), attemptId]);
    const draft = await this.draft(attemptId);
    if (!draft) throw new StoreError("这份练习已提交或已结束。", 409);
    return draft;
  }
  async addHint(attemptId: string, questionId: string): Promise<AnswerDraft> {
    const draft = await this.draft(attemptId);
    if (!draft) throw new StoreError("这份练习已提交或已结束。", 409);
    await this.client.query("UPDATE drafts SET hinted_json=$1, updated_at=$2 WHERE id=$3", [JSON.stringify([...new Set([...draft.hintedQuestionIds, questionId])]), now(), attemptId]);
    return (await this.draft(attemptId))!;
  }
  async markInterrupted(attemptId: string, reason: string): Promise<void> {
    await this.client.query("UPDATE drafts SET interruption=$1, updated_at=$2 WHERE id=$3 AND status='in_progress'", [reason.slice(0, 240), now(), attemptId]);
  }
  async abandonAttempt(attemptId: string): Promise<void> {
    const result = await this.client.query("UPDATE drafts SET status='abandoned', updated_at=$1 WHERE id=$2 AND status='in_progress'", [now(), attemptId]);
    if (result.rowCount !== 1) throw new StoreError("这份练习已结束或找不到记录。", 404);
  }
  private dateAfter(days: number): string {
    const date = new Date(`${this.today()}T12:00:00+08:00`); date.setDate(date.getDate() + days); return date.toISOString().slice(0, 10);
  }
  async submitDraft(draft: AnswerDraft, activity: Activity, responses: QuestionResult[]): Promise<AttemptResult> {
    const existing = await this.attempt(draft.attemptId);
    if (existing) return existing;
    if (!["mock", "review", "practice"].includes(draft.mode)) throw new Error("练习模式无效");
    const submittedAt = now();
    const result: AttemptResult = { ...draft, pluginId: activity.pluginId, submittedAt, score: responses.filter((item) => item.correct).length, total: responses.length, responses, sample: activity.sample };
    await this.client.query("BEGIN");
    try {
      const inserted = await this.client.query(`INSERT INTO attempts (id, activity_id, plugin_id, mode, answers_json, hinted_json, started_at, submitted_at, score, total, responses_json, sample, question_time_seconds_json, exam_timing_json)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT (id) DO NOTHING RETURNING id`, [result.attemptId, result.activityId, result.pluginId, result.mode, JSON.stringify(result.answers), JSON.stringify(result.hintedQuestionIds), result.startedAt, submittedAt, result.score, result.total, JSON.stringify(responses), result.sample, JSON.stringify(result.questionTimeSeconds ?? {}), result.examTiming ? JSON.stringify(result.examTiming) : null]);
      if (inserted.rowCount !== 1) {
        await this.client.query("COMMIT");
        return (await this.attempt(draft.attemptId))!;
      }
      await this.client.query("UPDATE drafts SET status='submitted', updated_at=$1 WHERE id=$2 AND status='in_progress'", [submittedAt, result.attemptId]);
      for (const response of responses) {
        const prior = await this.one("SELECT streak FROM review_schedule WHERE question_id=$1", [response.questionId]);
        if (!prior && result.mode !== "review" && response.correct && response.independent) continue;
        const independentCorrect = response.correct && response.independent;
        const streak = independentCorrect ? Number(prior?.streak ?? 0) + 1 : 0;
        const interval = independentCorrect ? [1, 3, 7, 14][Math.min(Math.max(streak - 1, 0), 3)]! : 1;
        const lastResult = independentCorrect ? "correct" : response.correct ? "hinted" : "incorrect";
        await this.client.query(`INSERT INTO review_schedule (question_id, activity_id, plugin_id, streak, interval_days, due_date, last_result, last_seen)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (question_id) DO UPDATE SET
          streak=CASE WHEN EXCLUDED.last_result='correct' THEN review_schedule.streak+1 ELSE 0 END,
          interval_days=EXCLUDED.interval_days, due_date=EXCLUDED.due_date, last_result=EXCLUDED.last_result, last_seen=EXCLUDED.last_seen, activity_id=EXCLUDED.activity_id`, [response.questionId, response.materialId, result.pluginId, streak, interval, this.dateAfter(interval), lastResult, submittedAt]);
      }
      if (draft.taskId) await this.client.query("UPDATE plan_tasks SET status='done' WHERE id=$1", [draft.taskId]);
      await this.client.query("COMMIT");
    } catch (error) {
      await this.client.query("ROLLBACK");
      const committed = await this.attempt(draft.attemptId);
      if (committed) return committed;
      throw error;
    }
    return result;
  }
  async attempt(attemptId: string): Promise<AttemptResult | undefined> {
    const row = await this.one("SELECT * FROM attempts WHERE id=$1", [attemptId]);
    return row ? this.toAttempt(row) : undefined;
  }
  async saveCause(attemptId: string, questionId: string, skillTag: string, cause: string): Promise<void> {
    await this.client.query("INSERT INTO causes (id, attempt_id, question_id, skill_tag, cause, confirmed_at) VALUES ($1,$2,$3,$4,$5,$6)", [randomUUID(), attemptId, questionId, skillTag, cause.slice(0, 120), now()]);
  }
  async evidence(): Promise<SkillEvidence[]> {
    const rows = await this.rows("SELECT plugin_id, mode, responses_json, question_time_seconds_json, submitted_at FROM attempts ORDER BY submitted_at ASC");
    type FirstSeen = { pluginId: Section; first: QuestionResult; firstAt: string; firstIndependent?: QuestionResult; firstIndependentAt?: string };
    const questions = new Map<string, FirstSeen>();
    const timingSamples: Array<{ questionId: string; seconds: number; submittedAt: string }> = [];
    const timed = new Set<string>();
    for (const row of rows) {
      if (row.mode === "review") continue;
      const submittedAt = String(row.submitted_at);
      const responses = parse(row.responses_json, [] as QuestionResult[]);
      const times = parse(row.question_time_seconds_json, {} as Record<string, number>);
      for (const response of responses) {
        const current = questions.get(response.questionId);
        const first = current ?? { pluginId: row.plugin_id as Section, first: response, firstAt: submittedAt };
        if (response.independent && !first.firstIndependent) {
          first.firstIndependent = response; first.firstIndependentAt = submittedAt;
          const seconds = times[response.questionId];
          if (!timed.has(response.questionId) && Number.isFinite(seconds) && seconds > 0 && seconds <= 86_400) {
            timingSamples.push({ questionId: response.questionId, seconds, submittedAt }); timed.add(response.questionId);
          }
        }
        questions.set(response.questionId, first);
      }
    }
    const cutoff = Date.now() - 30 * 86_400_000;
    const groups = new Map<string, SkillEvidence>();
    for (const item of questions.values()) {
      const response = item.firstIndependent ?? item.first;
      const timestamp = item.firstIndependentAt ?? item.firstAt;
      for (const tag of new Set([...item.first.skillTags, ...(item.firstIndependent?.skillTags ?? [])])) {
        const id = `${item.pluginId}:${tag}`;
        const current = groups.get(id) ?? { pluginId: item.pluginId, skillTag: tag, observed: 0, independent: 0, total: 0, hinted: 0, lastSeen: "", confidence: "emerging" as const, independentSamples: 0, recentTotal: 0, recentCorrect: 0, recentIndependentCorrect: 0, recentIndependentSamples: 0, recentHinted: 0, recentCauseCount: 0 };
        current.total += 1;
        current.independentSamples = (current.independentSamples ?? 0) + Number(Boolean(item.firstIndependent));
        current.observed += Number(response.correct);
        current.independent += Number(Boolean(item.firstIndependent?.correct && item.firstIndependent.skillTags.includes(tag)));
        current.hinted += Number(!item.first.independent && item.first.skillTags.includes(tag));
        if (timestamp > current.lastSeen) current.lastSeen = timestamp;
        if (Date.parse(timestamp) >= cutoff) {
          current.recentTotal = (current.recentTotal ?? 0) + 1;
          current.recentCorrect = (current.recentCorrect ?? 0) + Number(response.correct);
          current.recentIndependentCorrect = (current.recentIndependentCorrect ?? 0) + Number(Boolean(item.firstIndependent?.correct && item.firstIndependent.skillTags.includes(tag)));
          current.recentIndependentSamples = (current.recentIndependentSamples ?? 0) + Number(Boolean(item.firstIndependent && Date.parse(item.firstIndependentAt ?? "") >= cutoff && item.firstIndependent.skillTags.includes(tag)));
          current.recentHinted = (current.recentHinted ?? 0) + Number(Date.parse(item.firstAt) >= cutoff && !item.first.independent && item.first.skillTags.includes(tag));
        }
        groups.set(id, current);
      }
    }
    const causes = await this.rows("SELECT question_id, skill_tag, cause, confirmed_at FROM causes ORDER BY confirmed_at DESC");
    const causeMap = new Map<string, string>(); const causeSeen = new Set<string>();
    for (const row of causes) {
      const pluginId = questions.get(String(row.question_id))?.pluginId;
      if (!pluginId) continue;
      const tag = String(row.skill_tag); const groupId = `${pluginId}:${tag}`;
      const unique = `${groupId}:${String(row.question_id)}`;
      if (!causeSeen.has(unique)) {
        causeSeen.add(unique);
        const item = groups.get(groupId);
        if (item && Date.parse(String(row.confirmed_at)) >= cutoff) item.recentCauseCount = (item.recentCauseCount ?? 0) + 1;
      }
      if (!causeMap.has(groupId)) causeMap.set(groupId, String(row.cause));
    }
    const timingByTag = new Map<string, { all: number[]; recent: number[] }>();
    for (const sample of timingSamples) {
      const response = questions.get(sample.questionId)?.firstIndependent;
      const pluginId = questions.get(sample.questionId)?.pluginId;
      if (!response || !pluginId) continue;
      for (const tag of response.skillTags) {
        const id = `${pluginId}:${tag}`; const values = timingByTag.get(id) ?? { all: [], recent: [] };
        values.all.push(sample.seconds); if (Date.parse(sample.submittedAt) >= cutoff) values.recent.push(sample.seconds);
        timingByTag.set(id, values);
      }
    }
    const median = (values: number[]) => {
      const sorted = [...values].sort((a, b) => a - b); if (!sorted.length) return undefined;
      const middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1]! + sorted[middle]!) / 2;
    };
    for (const [id, item] of groups) {
      const counts = timingByTag.get(id);
      item.confidence = item.total >= 8 ? "established" : item.total >= 3 ? "developing" : "emerging";
      item.evidenceStatus = (item.independentSamples ?? 0) < 3 ? "insufficient" : "observed";
      item.userConfirmedCause = causeMap.get(id);
      item.recentMedianSeconds = median(counts?.recent ?? []);
      item.lifetimeMedianSeconds = median(counts?.all ?? []);
    }
    return [...groups.values()].sort((a, b) => a.pluginId.localeCompare(b.pluginId) || a.skillTag.localeCompare(b.skillTag));
  }

  async attemptedQuestionIds(): Promise<string[]> {
    const rows = await this.rows("SELECT mode, responses_json FROM attempts ORDER BY submitted_at ASC");
    const ids = new Set<string>();
    for (const row of rows) if (row.mode !== "review") for (const response of parse(row.responses_json, [] as QuestionResult[])) if (response.independent) ids.add(response.questionId);
    return [...ids];
  }

  async questionTimingSamples(): Promise<Array<{ questionId: string; seconds: number; submittedAt: string }>> {
    const rows = await this.rows("SELECT mode, responses_json, question_time_seconds_json, submitted_at FROM attempts ORDER BY submitted_at ASC");
    const seen = new Set<string>(); const samples: Array<{ questionId: string; seconds: number; submittedAt: string }> = [];
    for (const row of rows) {
      if (row.mode === "review") continue;
      const times = parse(row.question_time_seconds_json, {} as Record<string, number>); const submittedAt = String(row.submitted_at);
      for (const response of parse(row.responses_json, [] as QuestionResult[])) {
        const seconds = times[response.questionId];
        if (!response.independent || seen.has(response.questionId) || !Number.isFinite(seconds) || seconds <= 0 || seconds > 86_400) continue;
        samples.push({ questionId: response.questionId, seconds, submittedAt }); seen.add(response.questionId);
      }
    }
    return samples;
  }
  async attempts(limit = 40): Promise<AttemptResult[]> {
    return (await this.rows("SELECT * FROM attempts ORDER BY submitted_at DESC LIMIT $1", [limit])).map((row) => this.toAttempt(row));
  }
  today(): string { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); }
  async reviews(today = this.today()): Promise<Array<{ questionId: string; activityId: string; pluginId: Section; dueDate: string; lastResult: string; streak: number }>> {
    return (await this.rows("SELECT question_id AS \"questionId\", activity_id AS \"activityId\", plugin_id AS \"pluginId\", due_date AS \"dueDate\", last_result AS \"lastResult\", streak FROM review_schedule WHERE due_date <= $1 ORDER BY due_date", [today])).map((row) => ({ questionId: String(row.questionId), activityId: String(row.activityId), pluginId: row.pluginId as Section, dueDate: String(row.dueDate), lastResult: String(row.lastResult), streak: Number(row.streak) }));
  }
  async reviewsForActivity(activityId: string, today = this.today()): Promise<Array<{ questionId: string; dueDate: string; lastResult: string }>> {
    return (await this.rows("SELECT question_id AS \"questionId\", due_date AS \"dueDate\", last_result AS \"lastResult\" FROM review_schedule WHERE activity_id=$1 AND due_date <= $2 ORDER BY due_date LIMIT 10", [activityId, today])).map((row) => ({ questionId: String(row.questionId), dueDate: String(row.dueDate), lastResult: String(row.lastResult) }));
  }
  async dueReviewCount(): Promise<number> { const row = await this.one("SELECT COUNT(*) AS count FROM review_schedule WHERE due_date <= $1", [this.today()]); return Number(row?.count ?? 0); }
  async savePlan(tasks: PlanTask[], revision: string): Promise<void> {
    await this.client.query("BEGIN");
    try {
      for (const item of tasks) {
        const exists = await this.one("SELECT id FROM plan_tasks WHERE id=$1 AND locked=TRUE", [item.id]); if (exists) continue;
        await this.client.query(`INSERT INTO plan_tasks (id,date,activity_id,plugin_id,kind,title,description,minutes,reason,review_question_ids_json,question_ids_json,focus_skill_tag,question_kind,locked,status,revision)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,FALSE,'pending',$14) ON CONFLICT (id) DO UPDATE SET
          date=EXCLUDED.date, activity_id=EXCLUDED.activity_id, plugin_id=EXCLUDED.plugin_id, kind=EXCLUDED.kind, title=EXCLUDED.title,
          description=EXCLUDED.description, minutes=EXCLUDED.minutes, reason=EXCLUDED.reason, review_question_ids_json=EXCLUDED.review_question_ids_json,
          question_ids_json=EXCLUDED.question_ids_json, focus_skill_tag=EXCLUDED.focus_skill_tag, question_kind=EXCLUDED.question_kind, revision=EXCLUDED.revision
          WHERE plan_tasks.locked=FALSE`, [item.id,item.date,item.activityId,item.pluginId,item.kind,item.title,item.description,item.minutes,item.reason,JSON.stringify(item.reviewQuestionIds ?? []),JSON.stringify(item.questionIds ?? []),item.focusSkillTag ?? null,item.questionKind ?? null,revision]);
      }
      await this.client.query("COMMIT");
    } catch (error) { await this.client.query("ROLLBACK"); throw error; }
  }
  private async planRows(today: string): Promise<PlanTask[]> {
    const rows = await this.rows(`SELECT id,date,activity_id AS \"activityId\",plugin_id AS \"pluginId\",kind,title,description,minutes,reason,
      review_question_ids_json AS \"reviewQuestionIdsJson\",question_ids_json AS \"questionIdsJson\",focus_skill_tag AS \"focusSkillTag\",question_kind AS \"questionKind\",locked,status
      FROM plan_tasks WHERE date = $1 ORDER BY kind DESC,id LIMIT 80`, [today]);
    return rows.map((row) => ({ id:String(row.id),date:String(row.date),activityId:String(row.activityId),pluginId:row.pluginId as Section,kind:row.kind as PlanTask["kind"],title:String(row.title),description:String(row.description),minutes:Number(row.minutes),reason:String(row.reason),reviewQuestionIds:parse(row.reviewQuestionIdsJson,[] as string[]),questionIds:parse(row.questionIdsJson,[] as string[]),focusSkillTag:row.focusSkillTag ? String(row.focusSkillTag) : undefined,questionKind:row.questionKind as PlanTask["questionKind"],locked:bool(row.locked),status:row.status as PlanTask["status"] }));
  }
  async plan(today = this.today()): Promise<PlanTask[]> { return this.planRows(today); }
  async overduePlanTasks(today = this.today()): Promise<PlanTask[]> {
    const rows = await this.rows(`SELECT id,date,activity_id AS \"activityId\",plugin_id AS \"pluginId\",kind,title,description,minutes,reason,
      review_question_ids_json AS \"reviewQuestionIdsJson\",question_ids_json AS \"questionIdsJson\",focus_skill_tag AS \"focusSkillTag\",question_kind AS \"questionKind\",locked,status
      FROM plan_tasks WHERE date < $1 AND status='pending' ORDER BY date,id LIMIT 80`, [today]);
    return rows.map((row) => ({ id:String(row.id),date:String(row.date),activityId:String(row.activityId),pluginId:row.pluginId as Section,kind:row.kind as PlanTask["kind"],title:String(row.title),description:String(row.description),minutes:Number(row.minutes),reason:String(row.reason),reviewQuestionIds:parse(row.reviewQuestionIdsJson,[] as string[]),questionIds:parse(row.questionIdsJson,[] as string[]),focusSkillTag:row.focusSkillTag ? String(row.focusSkillTag) : undefined,questionKind:row.questionKind as PlanTask["questionKind"],locked:bool(row.locked),status:row.status as PlanTask["status"] }));
  }
  async clearUnlockedPendingPlan(today = this.today()): Promise<void> { await this.client.query("DELETE FROM plan_tasks WHERE date >= $1 AND locked=FALSE AND status='pending'", [today]); }
  async planProposal(): Promise<PlanProposal & { inputRevision?: string }> {
    const row = await this.one(`SELECT id,status,input_revision AS \"inputRevision\",tasks_json AS \"tasksJson\",changes_json AS \"changesJson\",error,updated_at AS \"updatedAt\",plan_date AS \"planDate\" FROM plan_proposals WHERE singleton=1`);
    if (!row) return { status: "idle", changes: [] };
    return { id:String(row.id),status:row.status as PlanProposal["status"],...(row.planDate ? { planDate:String(row.planDate) } : {}),inputRevision:String(row.inputRevision),...(row.status === "ready" ? { tasks:parse(row.tasksJson,[] as PlanTask[]) } : {}),changes:parse(row.changesJson,[] as PlanProposalChange[]),...(row.error?{error:String(row.error)}:{}),updatedAt:String(row.updatedAt) };
  }
  async beginPlanProposal(inputRevision: string, planDate = this.today()): Promise<string> {
    const id = randomUUID();
    await this.client.query(`INSERT INTO plan_proposals (singleton,id,status,input_revision,tasks_json,changes_json,error,updated_at,plan_date)
      VALUES (1,$1,'generating',$2,'[]','[]',NULL,$3,$4) ON CONFLICT (singleton) DO UPDATE SET id=EXCLUDED.id,status='generating',input_revision=EXCLUDED.input_revision,tasks_json='[]',changes_json='[]',error=NULL,updated_at=EXCLUDED.updated_at,plan_date=EXCLUDED.plan_date`, [id,inputRevision,now(),planDate]);
    return id;
  }
  async beginPlanProposalIfIdle(inputRevision: string, planDate: string, options: { retryFailed?: boolean; recoverStaleBefore?: string } = {}): Promise<string | undefined> {
    await this.client.query("BEGIN");
    try {
      await this.client.query(`INSERT INTO plan_proposals (singleton,id,status,input_revision,tasks_json,changes_json,error,updated_at,plan_date)
        VALUES (1,$1,'idle','','[]','[]',NULL,$2,NULL) ON CONFLICT (singleton) DO NOTHING`, [randomUUID(), now()]);
      const row = await this.one(`SELECT status, plan_date AS "planDate", updated_at AS "updatedAt" FROM plan_proposals WHERE singleton=1 FOR UPDATE`);
      if (row && String(row.planDate ?? "") === planDate) {
        const status = String(row.status) as PlanProposal["status"];
        const recover = status === "generating" && options.recoverStaleBefore !== undefined && String(row.updatedAt) < options.recoverStaleBefore;
        const retry = status === "failed" && options.retryFailed === true;
        if (!recover && !retry) { await this.client.query("ROLLBACK"); return undefined; }
      }
      const id = randomUUID();
      await this.client.query(`INSERT INTO plan_proposals (singleton,id,status,input_revision,tasks_json,changes_json,error,updated_at,plan_date)
        VALUES (1,$1,'generating',$2,'[]','[]',NULL,$3,$4) ON CONFLICT (singleton) DO UPDATE SET id=EXCLUDED.id,status='generating',input_revision=EXCLUDED.input_revision,tasks_json='[]',changes_json='[]',error=NULL,updated_at=EXCLUDED.updated_at,plan_date=EXCLUDED.plan_date`, [id,inputRevision,now(),planDate]);
      await this.client.query("COMMIT");
      return id;
    } catch (error) { await this.client.query("ROLLBACK"); throw error; }
  }
  async completePlanProposal(id: string, tasks: PlanTask[], changes: PlanProposalChange[]): Promise<boolean> {
    const result = await this.client.query(`UPDATE plan_proposals SET status='ready',tasks_json=$1,changes_json=$2,error=NULL,updated_at=$3 WHERE singleton=1 AND id=$4 AND status='generating'`, [JSON.stringify(tasks),JSON.stringify(changes),now(),id]);
    return result.rowCount === 1;
  }
  async planProposalTasks(id: string): Promise<PlanTask[] | undefined> {
    const row = await this.one("SELECT tasks_json FROM plan_proposals WHERE singleton=1 AND id=$1 AND status='ready'", [id]);
    return row ? parse(row.tasks_json, [] as PlanTask[]) : undefined;
  }
  async failPlanProposal(id: string, message: string): Promise<boolean> {
    const result = await this.client.query(`UPDATE plan_proposals SET status='failed',error=$1,updated_at=$2 WHERE singleton=1 AND id=$3 AND status='generating'`, [message.slice(0,240),now(),id]); return result.rowCount === 1;
  }
  async failReadyPlanProposal(id: string, message: string): Promise<boolean> {
    const result = await this.client.query(`UPDATE plan_proposals SET status='failed',error=$1,updated_at=$2 WHERE singleton=1 AND id=$3 AND status='ready'`, [message.slice(0,240),now(),id]); return result.rowCount === 1;
  }
  async dismissPlanProposal(id: string): Promise<boolean> {
    const result = await this.client.query(`UPDATE plan_proposals SET status='dismissed',updated_at=$1 WHERE singleton=1 AND id=$2 AND status='ready'`, [now(),id]); return result.rowCount === 1;
  }
  async applyPlanProposal(id: string): Promise<boolean> {
    await this.client.query("BEGIN");
    try {
      const proposal = await this.one("SELECT tasks_json,plan_date AS \"planDate\" FROM plan_proposals WHERE singleton=1 AND id=$1 AND status='ready' FOR UPDATE", [id]);
      if (!proposal) { await this.client.query("ROLLBACK"); return false; }
      const tasks = parse(proposal.tasks_json, [] as PlanTask[]); const revision = now(); const planDate = String(proposal.planDate ?? this.today());
      await this.client.query("UPDATE plan_tasks SET status='expired' WHERE date < $1 AND status='pending'", [planDate]);
      await this.client.query("DELETE FROM plan_tasks WHERE date = $1 AND locked=FALSE AND status='pending'", [planDate]);
      for (const task of tasks) await this.client.query(`INSERT INTO plan_tasks (id,date,activity_id,plugin_id,kind,title,description,minutes,reason,review_question_ids_json,question_ids_json,focus_skill_tag,question_kind,locked,status,revision)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,FALSE,'pending',$14)`, [task.id,task.date,task.activityId,task.pluginId,task.kind,task.title,task.description,task.minutes,task.reason,JSON.stringify(task.reviewQuestionIds ?? []),JSON.stringify(task.questionIds ?? []),task.focusSkillTag ?? null,task.questionKind ?? null,revision]);
      const update = await this.client.query("UPDATE plan_proposals SET status='confirmed',updated_at=$1 WHERE singleton=1 AND id=$2 AND status='ready'", [revision,id]);
      await this.client.query("COMMIT"); return update.rowCount === 1;
    } catch (error) { await this.client.query("ROLLBACK"); throw error; }
  }
  async setPlanTask(id: string, changes: { locked?: boolean; status?: "pending" | "done" }): Promise<PlanTask | undefined> {
    if (changes.locked !== undefined) await this.client.query("UPDATE plan_tasks SET locked=$1 WHERE id=$2", [changes.locked,id]);
    if (changes.status !== undefined) await this.client.query("UPDATE plan_tasks SET status=$1 WHERE id=$2", [changes.status,id]);
    const row = await this.one(`SELECT id,date,activity_id AS "activityId",plugin_id AS "pluginId",kind,title,description,minutes,reason,
      review_question_ids_json AS "reviewQuestionIdsJson",question_ids_json AS "questionIdsJson",focus_skill_tag AS "focusSkillTag",question_kind AS "questionKind",locked,status
      FROM plan_tasks WHERE id=$1 LIMIT 1`, [id]);
    if (!row) return undefined;
    return { id:String(row.id),date:String(row.date),activityId:String(row.activityId),pluginId:row.pluginId as Section,kind:row.kind as PlanTask["kind"],title:String(row.title),description:String(row.description),minutes:Number(row.minutes),reason:String(row.reason),reviewQuestionIds:parse(row.reviewQuestionIdsJson,[] as string[]),questionIds:parse(row.questionIdsJson,[] as string[]),focusSkillTag:row.focusSkillTag ? String(row.focusSkillTag) : undefined,questionKind:row.questionKind as PlanTask["questionKind"],locked:bool(row.locked),status:row.status as PlanTask["status"] };
  }
  async addCoachMessage(conversationId: string, role: CoachMessage["role"], text: string, questionId?: string): Promise<CoachMessage> {
    const message: CoachMessage = { id:randomUUID(),conversationId,role,text:text.slice(0,8000),createdAt:now() };
    await this.client.query("INSERT INTO coach_messages (id,conversation_id,role,text,created_at,question_id) VALUES ($1,$2,$3,$4,$5,$6)", [message.id,conversationId,role,message.text,message.createdAt,questionId ?? null]); return message;
  }
  async coachHistory(conversationId: string): Promise<CoachMessage[]> {
    return (await this.rows(`SELECT id,conversation_id AS \"conversationId\",role,text,created_at AS \"createdAt\" FROM coach_messages WHERE conversation_id=$1 ORDER BY created_at DESC LIMIT 20`,[conversationId])).reverse().map((row) => ({id:String(row.id),conversationId:String(row.conversationId),role:row.role as CoachMessage["role"],text:String(row.text),createdAt:String(row.createdAt)}));
  }
  async close(): Promise<void> { /* The request-scoped Neon client is closed by its Vercel handler. */ }
}
