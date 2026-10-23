import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  Activity,
  ActivityMode,
  AnswerDraft,
  AttemptResult,
  CoachMessage,
  LearnerProfile,
  PlanTask,
  PlanProposal,
  PlanProposalChange,
  QuestionResult,
  Section,
  SkillEvidence,
} from "../src/shared/domain.js";
import { StoreError } from "./store-error.js";
import { examDeadline, type ExamTiming } from "../src/shared/domain.js";

const utcNow = () => new Date().toISOString();
const parse = <T>(value: string | null | undefined, fallback: T): T => {
  try { return value ? JSON.parse(value) as T : fallback; } catch { return fallback; }
};

type DraftRow = {
  id: string;
  activity_id: string;
  mode: ActivityMode;
  answers_json: string;
  hinted_json: string;
  started_at: string;
  updated_at: string;
  status: string;
  interruption: string | null;
  task_id: string | null;
  review_question_ids_json: string;
  question_ids_json: string;
  question_time_seconds_json: string;
  client_revision: number;
  exam_timing_json: string | null;
};

type AttemptRow = {
  id: string;
  activity_id: string;
  plugin_id: Section;
  mode: ActivityMode;
  answers_json: string;
  hinted_json: string;
  started_at: string;
  submitted_at: string;
  score: number;
  total: number;
  responses_json: string;
  question_time_seconds_json: string;
  sample: number;
  exam_timing_json: string | null;
};

export class LearningStore {
  readonly database: DatabaseSync;

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    this.database.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS profile (
        id TEXT PRIMARY KEY, target_listening REAL NOT NULL, target_reading REAL NOT NULL,
        exam_date TEXT NOT NULL, daily_minutes INTEGER NOT NULL, updated_at TEXT NOT NULL,
        setup_complete INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS imported_activities (
        id TEXT PRIMARY KEY, plugin_id TEXT NOT NULL, activity_json TEXT NOT NULL, imported_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS drafts (
        id TEXT PRIMARY KEY, activity_id TEXT NOT NULL, mode TEXT NOT NULL, answers_json TEXT NOT NULL,
        hinted_json TEXT NOT NULL, started_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        status TEXT NOT NULL, interruption TEXT, task_id TEXT, review_question_ids_json TEXT NOT NULL DEFAULT '[]',
        question_ids_json TEXT NOT NULL DEFAULT '[]', question_time_seconds_json TEXT NOT NULL DEFAULT '{}',
        client_revision INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS attempts (
        id TEXT PRIMARY KEY, activity_id TEXT NOT NULL, plugin_id TEXT NOT NULL, mode TEXT NOT NULL,
        answers_json TEXT NOT NULL, hinted_json TEXT NOT NULL, started_at TEXT NOT NULL,
        submitted_at TEXT NOT NULL, score INTEGER NOT NULL, total INTEGER NOT NULL,
        responses_json TEXT NOT NULL, sample INTEGER NOT NULL, question_time_seconds_json TEXT NOT NULL DEFAULT '{}'
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
        focus_skill_tag TEXT, question_kind TEXT, locked INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending',
        revision TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS plan_proposals (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1), id TEXT NOT NULL,
        status TEXT NOT NULL, input_revision TEXT NOT NULL, tasks_json TEXT NOT NULL,
        changes_json TEXT NOT NULL, error TEXT, updated_at TEXT NOT NULL, plan_date TEXT
      );
      CREATE TABLE IF NOT EXISTS coach_messages (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL,
        text TEXT NOT NULL, created_at TEXT NOT NULL, question_id TEXT
      );
      CREATE INDEX IF NOT EXISTS coach_messages_recent ON coach_messages(conversation_id, created_at);
      CREATE INDEX IF NOT EXISTS plan_by_date ON plan_tasks(date, status);
      CREATE INDEX IF NOT EXISTS attempts_recent ON attempts(submitted_at);
    `);
    const ensureColumn = (table: string, column: string, definition: string) => {
      const columns = this.database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      if (!columns.some((item) => item.name === column)) this.database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    };
    ensureColumn("drafts", "question_ids_json", "TEXT NOT NULL DEFAULT '[]'");
    ensureColumn("drafts", "question_time_seconds_json", "TEXT NOT NULL DEFAULT '{}' ");
    ensureColumn("drafts", "client_revision", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn("attempts", "question_time_seconds_json", "TEXT NOT NULL DEFAULT '{}' ");
    ensureColumn("drafts", "exam_timing_json", "TEXT");
    ensureColumn("attempts", "exam_timing_json", "TEXT");
    ensureColumn("plan_tasks", "question_ids_json", "TEXT NOT NULL DEFAULT '[]'");
    ensureColumn("plan_tasks", "focus_skill_tag", "TEXT");
    ensureColumn("plan_tasks", "question_kind", "TEXT");
    ensureColumn("plan_proposals", "plan_date", "TEXT");
    // Legacy seven-day tasks have no selected question IDs, so they cannot be safely resumed as adaptive units.
    this.database.prepare("UPDATE plan_tasks SET status='expired' WHERE status='pending' AND question_ids_json='[]'").run();
    this.database.prepare(`INSERT OR IGNORE INTO profile
      (id, target_listening, target_reading, exam_date, daily_minutes, updated_at, setup_complete)
      VALUES ('local-learner', 7, 7, ?, 45, ?, 0)`)
      .run(this.defaultExamDate(), utcNow());
  }

  private defaultExamDate(): string {
    const date = new Date();
    date.setDate(date.getDate() + 60);
    return date.toISOString().slice(0, 10);
  }

  profile(): LearnerProfile {
    const row = this.database.prepare("SELECT * FROM profile WHERE id='local-learner'").get() as {
      id: string; target_listening: number; target_reading: number; exam_date: string; daily_minutes: number; updated_at: string; setup_complete: number;
    };
    return { id: row.id, targetListening: row.target_listening, targetReading: row.target_reading, examDate: row.exam_date, dailyMinutes: row.daily_minutes, updatedAt: row.updated_at, setupComplete: Boolean(row.setup_complete) };
  }

  saveProfile(input: Pick<LearnerProfile, "targetListening" | "targetReading" | "examDate" | "dailyMinutes">): LearnerProfile {
    this.database.prepare(`UPDATE profile SET target_listening=?, target_reading=?, exam_date=?, daily_minutes=?, updated_at=?, setup_complete=1 WHERE id='local-learner'`)
      .run(input.targetListening, input.targetReading, input.examDate, input.dailyMinutes, utcNow());
    return this.profile();
  }

  importedActivities(): Activity[] {
    return (this.database.prepare("SELECT activity_json FROM imported_activities ORDER BY imported_at DESC").all() as Array<{ activity_json: string }>).map((row) => JSON.parse(row.activity_json) as Activity);
  }

  importActivities(activities: Activity[]): number {
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const insert = this.database.prepare("INSERT OR REPLACE INTO imported_activities (id, plugin_id, activity_json, imported_at) VALUES (?, ?, ?, ?)");
      const time = utcNow();
      for (const activity of activities) insert.run(activity.id, activity.pluginId, JSON.stringify(activity), time);
      this.database.exec("COMMIT;");
      return activities.length;
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
  }

  activityById(activities: Activity[], activityId: string): Activity | undefined { return activities.find((item) => item.id === activityId); }

  saveMockPaper(activity: Activity): void {
    this.database.prepare("INSERT INTO mock_papers (id, activity_json, created_at) VALUES (?, ?, ?)").run(activity.id, JSON.stringify(activity), utcNow());
  }

  mockPaper(id: string): Activity | undefined {
    const row = this.database.prepare("SELECT activity_json FROM mock_papers WHERE id=?").get(id) as { activity_json: string } | undefined;
    return row ? JSON.parse(row.activity_json) as Activity : undefined;
  }

  startAttempt(activityId: string, mode: ActivityMode, taskId?: string, reviewQuestionIds?: string[], questionIds?: string[], examTiming?: ExamTiming): AnswerDraft {
    const now = utcNow();
    const id = crypto.randomUUID();
    const selectedIds = questionIds ?? reviewQuestionIds ?? [];
    this.database.prepare("INSERT INTO drafts (id, activity_id, mode, answers_json, hinted_json, started_at, updated_at, status, interruption, task_id, review_question_ids_json, question_ids_json, question_time_seconds_json, exam_timing_json) VALUES (?, ?, ?, '{}', '[]', ?, ?, 'in_progress', NULL, ?, ?, ?, '{}', ?)")
      .run(id, activityId, mode, now, now, taskId ?? null, JSON.stringify(reviewQuestionIds ?? []), JSON.stringify(selectedIds), examTiming ? JSON.stringify(examTiming) : null);
    return { attemptId: id, activityId, ...(taskId ? { taskId } : {}), ...(selectedIds.length ? { questionIds: selectedIds } : {}), ...(reviewQuestionIds?.length ? { reviewQuestionIds } : {}), mode, answers: {}, questionTimeSeconds: {}, saveRevision: 0, hintedQuestionIds: [], startedAt: now, updatedAt: now, ...(examTiming ? { examTiming, deadlineAt: examDeadline(now, examTiming) } : {}) };
  }

  draft(attemptId: string): AnswerDraft | undefined {
    const row = this.database.prepare("SELECT * FROM drafts WHERE id=? AND status='in_progress'").get(attemptId) as DraftRow | undefined;
    return row ? this.toDraft(row) : undefined;
  }

  draftForActivity(activityId: string): AnswerDraft | undefined {
    const row = this.database.prepare("SELECT * FROM drafts WHERE activity_id=? AND status='in_progress' ORDER BY updated_at DESC LIMIT 1").get(activityId) as DraftRow | undefined;
    return row ? this.toDraft(row) : undefined;
  }

  private toDraft(row: DraftRow): AnswerDraft {
    const examTiming = parse<ExamTiming | undefined>(row.exam_timing_json, undefined);
    const questionIds = parse(row.question_ids_json, [] as string[]);
    return { ...(examTiming ? { examTiming, deadlineAt: examDeadline(row.started_at, examTiming) } : {}), attemptId: row.id, activityId: row.activity_id, ...(row.task_id ? { taskId: row.task_id } : {}), ...(questionIds.length ? { questionIds } : {}), reviewQuestionIds: parse(row.review_question_ids_json, []), mode: row.mode, answers: parse(row.answers_json, {}), questionTimeSeconds: parse(row.question_time_seconds_json, {} as Record<string, number>), saveRevision: Number(row.client_revision ?? 0), hintedQuestionIds: parse(row.hinted_json, []), startedAt: row.started_at, updatedAt: row.updated_at, ...(row.interruption ? { interruption: row.interruption } : {}) };
  }

  saveDraft(attemptId: string, answers: Record<string, string>, questionTimeSeconds: Record<string, number> | undefined, revision: number): AnswerDraft {
    if (!Number.isSafeInteger(revision) || revision <= 0) throw new StoreError("草稿保存版本无效。", 409);
    for (const [key, value] of Object.entries(answers)) {
      if (key.length > 64 || value.length > 1000) throw new Error("作答内容超出长度限制");
    }
    const current = this.draft(attemptId);
    if (!current) throw new StoreError("这份练习已提交或已结束。", 409);
    const requestedTimes = questionTimeSeconds === undefined ? {} : Object.fromEntries(Object.entries(questionTimeSeconds).filter(([key, value]) => key.length <= 64 && Number.isFinite(value) && value >= 0 && value <= 86_400));
    const times = { ...(current.questionTimeSeconds ?? {}) };
    for (const [key, value] of Object.entries(requestedTimes)) times[key] = Math.max(times[key] ?? 0, value);
    this.database.prepare("UPDATE drafts SET answers_json=?, question_time_seconds_json=?, client_revision=?, updated_at=? WHERE id=? AND status='in_progress' AND client_revision < ?")
      .run(JSON.stringify(answers), JSON.stringify(times), revision, utcNow(), attemptId, revision);
    const draft = this.draft(attemptId);
    if (!draft) throw new StoreError("这份练习已提交或已结束。", 409);
    return draft;
  }

  addHint(attemptId: string, questionId: string): AnswerDraft {
    const draft = this.draft(attemptId);
    if (!draft) throw new StoreError("这份练习已提交或已结束。", 409);
    const hinted = [...new Set([...draft.hintedQuestionIds, questionId])];
    this.database.prepare("UPDATE drafts SET hinted_json=?, updated_at=? WHERE id=?")
      .run(JSON.stringify(hinted), utcNow(), attemptId);
    return this.draft(attemptId)!;
  }

  markInterrupted(attemptId: string, reason: string): void {
    this.database.prepare("UPDATE drafts SET interruption=?, updated_at=? WHERE id=? AND status='in_progress'")
      .run(reason.slice(0, 240), utcNow(), attemptId);
  }

  abandonAttempt(attemptId: string): void {
    const result = this.database.prepare("UPDATE drafts SET status='abandoned', updated_at=? WHERE id=? AND status='in_progress'")
      .run(utcNow(), attemptId);
    if (result.changes !== 1) throw new StoreError("这份练习已结束或找不到记录。", 404);
  }

  submitDraft(draft: AnswerDraft, activity: Activity, responses: QuestionResult[]): AttemptResult {
    const existing = this.database.prepare("SELECT * FROM attempts WHERE id=?").get(draft.attemptId) as AttemptRow | undefined;
    if (existing) return this.toAttempt(existing);
    if (draft.mode !== "mock" && draft.mode !== "review" && draft.mode !== "practice") throw new Error("练习模式无效");
    const submittedAt = utcNow();
    const result: AttemptResult = { ...draft, pluginId: activity.pluginId, submittedAt, score: responses.filter((r) => r.correct).length, total: responses.length, responses, sample: activity.sample };
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      this.database.prepare(`INSERT INTO attempts (id,activity_id,plugin_id,mode,answers_json,hinted_json,started_at,submitted_at,score,total,responses_json,sample,question_time_seconds_json,exam_timing_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(result.attemptId, result.activityId, result.pluginId, result.mode, JSON.stringify(result.answers), JSON.stringify(result.hintedQuestionIds), result.startedAt, result.submittedAt, result.score, result.total, JSON.stringify(result.responses), Number(result.sample), JSON.stringify(result.questionTimeSeconds ?? {}), result.examTiming ? JSON.stringify(result.examTiming) : null);
      this.database.prepare("UPDATE drafts SET status='submitted', updated_at=? WHERE id=? AND status='in_progress'").run(submittedAt, result.attemptId);
      const upsert = this.database.prepare(`INSERT INTO review_schedule
        (question_id, activity_id, plugin_id, streak, interval_days, due_date, last_result, last_seen)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(question_id) DO UPDATE SET
          streak=CASE WHEN excluded.last_result='correct' THEN review_schedule.streak+1 ELSE 0 END,
          interval_days=excluded.interval_days, due_date=excluded.due_date,
          last_result=excluded.last_result, last_seen=excluded.last_seen, activity_id=excluded.activity_id`);
      for (const response of responses) {
        const prior = this.database.prepare("SELECT streak FROM review_schedule WHERE question_id=?").get(response.questionId) as { streak: number } | undefined;
        if (!prior && result.mode !== "review" && response.correct && response.independent) continue;
        const independentCorrect = response.correct && response.independent;
        const streak = independentCorrect ? (prior?.streak ?? 0) + 1 : 0;
        const interval = independentCorrect ? [1, 3, 7, 14][Math.min(Math.max(streak - 1, 0), 3)] : 1;
        const lastResult = independentCorrect ? "correct" : response.correct ? "hinted" : "incorrect";
        upsert.run(response.questionId, response.materialId, result.pluginId, streak, interval, this.dateAfter(interval), lastResult, submittedAt);
      }
      if (draft.taskId) this.database.prepare("UPDATE plan_tasks SET status='done' WHERE id=?").run(draft.taskId);
      this.database.exec("COMMIT;");
    } catch (error) {
      this.database.exec("ROLLBACK;");
      const committed = this.database.prepare("SELECT * FROM attempts WHERE id=?").get(draft.attemptId) as AttemptRow | undefined;
      if (committed) return this.toAttempt(committed);
      throw error;
    }
    return result;
  }

  private toAttempt(row: AttemptRow): AttemptResult {
    const examTiming = parse<ExamTiming | undefined>(row.exam_timing_json, undefined);
    const responses = parse(row.responses_json, [] as QuestionResult[]);
    const questionIds = [...new Set(responses.map((response) => response.questionId))];
    const draft: AnswerDraft = { ...(examTiming ? { examTiming, deadlineAt: examDeadline(row.started_at, examTiming) } : {}), attemptId: row.id, activityId: row.activity_id, mode: row.mode, ...(questionIds.length ? { questionIds } : {}), answers: parse(row.answers_json, {}), questionTimeSeconds: parse(row.question_time_seconds_json, {} as Record<string, number>), hintedQuestionIds: parse(row.hinted_json, []), startedAt: row.started_at, updatedAt: row.submitted_at };
    return { ...draft, pluginId: row.plugin_id, submittedAt: row.submitted_at, score: row.score, total: row.total, responses, sample: Boolean(row.sample) };
  }

  attempt(attemptId: string): AttemptResult | undefined {
    const row = this.database.prepare("SELECT * FROM attempts WHERE id=?").get(attemptId) as AttemptRow | undefined;
    return row ? this.toAttempt(row) : undefined;
  }

  saveCause(attemptId: string, questionId: string, skillTag: string, cause: string): void {
    this.database.prepare("INSERT INTO causes (id, attempt_id, question_id, skill_tag, cause, confirmed_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(crypto.randomUUID(), attemptId, questionId, skillTag, cause.slice(0, 120), utcNow());
  }

  evidence(): SkillEvidence[] {
    const rows = this.database.prepare("SELECT plugin_id, mode, responses_json, question_time_seconds_json, submitted_at FROM attempts ORDER BY submitted_at ASC").all() as Array<{ plugin_id: Section; mode: ActivityMode; responses_json: string; question_time_seconds_json: string; submitted_at: string }>;
    type FirstSeen = { pluginId: Section; first: QuestionResult; firstAt: string; firstIndependent?: QuestionResult; firstIndependentAt?: string };
    const questions = new Map<string, FirstSeen>();
    const timingSamples: Array<{ questionId: string; seconds: number; submittedAt: string }> = [];
    const timed = new Set<string>();
    for (const row of rows) {
      if (row.mode === "review") continue;
      const responses = parse(row.responses_json, [] as QuestionResult[]);
      const times = parse(row.question_time_seconds_json, {} as Record<string, number>);
      for (const response of responses) {
        const current = questions.get(response.questionId);
        const first = current ?? { pluginId: row.plugin_id, first: response, firstAt: row.submitted_at };
        if (response.independent && !first.firstIndependent) {
          first.firstIndependent = response;
          first.firstIndependentAt = row.submitted_at;
          const seconds = times[response.questionId];
          if (!timed.has(response.questionId) && Number.isFinite(seconds) && seconds > 0 && seconds <= 86_400) {
            timingSamples.push({ questionId: response.questionId, seconds, submittedAt: row.submitted_at });
            timed.add(response.questionId);
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
    const causes = this.database.prepare("SELECT question_id, skill_tag, cause, confirmed_at FROM causes ORDER BY confirmed_at DESC").all() as Array<{ question_id: string; skill_tag: string; cause: string; confirmed_at: string }>;
    const causeMap = new Map<string, string>();
    const causeSeen = new Set<string>();
    for (const row of causes) {
      const pluginId = questions.get(row.question_id)?.pluginId;
      if (!pluginId) continue;
      const key = `${pluginId}:${row.question_id}:${row.skill_tag}`;
      const groupKey = `${pluginId}:${row.skill_tag}`;
      if (!causeSeen.has(key)) {
        causeSeen.add(key);
        const item = groups.get(groupKey);
        if (item && Date.parse(row.confirmed_at) >= cutoff) item.recentCauseCount = (item.recentCauseCount ?? 0) + 1;
      }
      if (!causeMap.has(groupKey)) causeMap.set(groupKey, row.cause);
    }
    const questionById = new Map([...questions.entries()].map(([questionId, item]) => [questionId, item.firstIndependent]));
    const timesByTag = new Map<string, { all: number[]; recent: number[] }>();
    for (const sample of timingSamples) {
      const response = questionById.get(sample.questionId);
      if (!response) continue;
      for (const tag of response.skillTags) {
        const pluginId = questions.get(sample.questionId)!.pluginId;
        const key = `${pluginId}:${tag}`;
        const values = timesByTag.get(key) ?? { all: [], recent: [] };
        values.all.push(sample.seconds);
        if (Date.parse(sample.submittedAt) >= cutoff) values.recent.push(sample.seconds);
        timesByTag.set(key, values);
      }
    }
    const median = (values: number[]) => {
      const sorted = [...values].sort((a, b) => a - b);
      if (!sorted.length) return undefined;
      const middle = Math.floor(sorted.length / 2);
      return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1]! + sorted[middle]!) / 2;
    };
    for (const [id, item] of groups) {
      const counts = timesByTag.get(id);
      item.confidence = item.total >= 8 ? "established" : item.total >= 3 ? "developing" : "emerging";
      item.evidenceStatus = (item.independentSamples ?? 0) < 3 ? "insufficient" : "observed";
      item.userConfirmedCause = causeMap.get(id);
      item.recentMedianSeconds = median(counts?.recent ?? []);
      item.lifetimeMedianSeconds = median(counts?.all ?? []);
    }
    return [...groups.values()].sort((a, b) => a.pluginId.localeCompare(b.pluginId) || a.skillTag.localeCompare(b.skillTag));
  }

  attemptedQuestionIds(): string[] {
    const rows = this.database.prepare("SELECT mode, responses_json FROM attempts ORDER BY submitted_at ASC").all() as Array<{ mode: ActivityMode; responses_json: string }>;
    const ids = new Set<string>();
    for (const row of rows) if (row.mode !== "review") for (const response of parse(row.responses_json, [] as QuestionResult[])) if (response.independent) ids.add(response.questionId);
    return [...ids];
  }

  questionTimingSamples(): Array<{ questionId: string; seconds: number; submittedAt: string }> {
    const rows = this.database.prepare("SELECT mode, responses_json, question_time_seconds_json, submitted_at FROM attempts ORDER BY submitted_at ASC").all() as Array<{ mode: ActivityMode; responses_json: string; question_time_seconds_json: string; submitted_at: string }>;
    const seen = new Set<string>();
    const samples: Array<{ questionId: string; seconds: number; submittedAt: string }> = [];
    for (const row of rows) {
      if (row.mode === "review") continue;
      const times = parse(row.question_time_seconds_json, {} as Record<string, number>);
      for (const response of parse(row.responses_json, [] as QuestionResult[])) {
        const seconds = times[response.questionId];
        if (!response.independent || seen.has(response.questionId) || !Number.isFinite(seconds) || seconds <= 0 || seconds > 86_400) continue;
        samples.push({ questionId: response.questionId, seconds, submittedAt: row.submitted_at });
        seen.add(response.questionId);
      }
    }
    return samples;
  }

  attempts(limit = 40): AttemptResult[] {
    const rows = this.database.prepare("SELECT * FROM attempts ORDER BY submitted_at DESC LIMIT ?").all(limit) as AttemptRow[];
    return rows.map((row) => this.toAttempt(row));
  }

  reviews(today = this.today()): Array<{ questionId: string; activityId: string; pluginId: Section; dueDate: string; lastResult: string; streak: number }> {
    return this.database.prepare("SELECT question_id AS questionId, activity_id AS activityId, plugin_id AS pluginId, due_date AS dueDate, last_result AS lastResult, streak FROM review_schedule WHERE due_date<=? ORDER BY due_date").all(today) as Array<{ questionId: string; activityId: string; pluginId: Section; dueDate: string; lastResult: string; streak: number }>;
  }

  reviewsForActivity(activityId: string, today = this.today()): Array<{ questionId: string; dueDate: string; lastResult: string }> {
    return this.database.prepare("SELECT question_id AS questionId, due_date AS dueDate, last_result AS lastResult FROM review_schedule WHERE activity_id=? AND due_date<=? ORDER BY due_date LIMIT 10")
      .all(activityId, today) as Array<{ questionId: string; dueDate: string; lastResult: string }>;
  }

  dueReviewCount(): number {
    return Number((this.database.prepare("SELECT COUNT(*) AS count FROM review_schedule WHERE due_date<=?").get(this.today()) as { count: number }).count);
  }

  savePlan(tasks: PlanTask[], revision: string): void {
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const existing = this.database.prepare("SELECT id FROM plan_tasks WHERE id=? AND locked=1");
      const insert = this.database.prepare(`INSERT OR REPLACE INTO plan_tasks
        (id,date,activity_id,plugin_id,kind,title,description,minutes,reason,review_question_ids_json,question_ids_json,focus_skill_tag,question_kind,locked,status,revision)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,COALESCE((SELECT locked FROM plan_tasks WHERE id=?),0),COALESCE((SELECT status FROM plan_tasks WHERE id=?),'pending'),?)`);
      for (const item of tasks) {
        if (existing.get(item.id)) continue;
        insert.run(item.id,item.date,item.activityId,item.pluginId,item.kind,item.title,item.description,item.minutes,item.reason,JSON.stringify(item.reviewQuestionIds ?? []),JSON.stringify(item.questionIds ?? []),item.focusSkillTag ?? null,item.questionKind ?? null,item.id,item.id,revision);
      }
      this.database.exec("COMMIT;");
    } catch (error) { this.database.exec("ROLLBACK;"); throw error; }
  }

  private planRows(sql: string, date: string): PlanTask[] {
    return this.database.prepare(sql).all(date).map((row) => {
      const task = row as Record<string, unknown>;
      const { reviewQuestionIdsJson, questionIdsJson, focusSkillTag, questionKind, ...fields } = task;
      return { ...fields, questionIds: parse(String(questionIdsJson ?? "[]"), [] as string[]), focusSkillTag: focusSkillTag ? String(focusSkillTag) : undefined, questionKind: questionKind as PlanTask["questionKind"],
        reviewQuestionIds: parse(String(reviewQuestionIdsJson ?? "[]"), [] as string[]), locked: Boolean(task.locked) } as unknown as PlanTask;
    });
  }

  plan(today = this.today()): PlanTask[] {
    return this.planRows(`SELECT id,date,activity_id AS activityId,plugin_id AS pluginId,kind,title,description,minutes,reason,
      review_question_ids_json AS reviewQuestionIdsJson,question_ids_json AS questionIdsJson,focus_skill_tag AS focusSkillTag,question_kind AS questionKind,locked,status
      FROM plan_tasks WHERE date=? ORDER BY kind DESC,id LIMIT 80`, today);
  }

  overduePlanTasks(today = this.today()): PlanTask[] {
    return this.planRows(`SELECT id,date,activity_id AS activityId,plugin_id AS pluginId,kind,title,description,minutes,reason,
      review_question_ids_json AS reviewQuestionIdsJson,question_ids_json AS questionIdsJson,focus_skill_tag AS focusSkillTag,question_kind AS questionKind,locked,status
      FROM plan_tasks WHERE date<? AND status='pending' ORDER BY date,id LIMIT 80`, today);
  }

  clearUnlockedPendingPlan(today = this.today()): void {
    this.database.prepare("DELETE FROM plan_tasks WHERE date>=? AND locked=0 AND status='pending'").run(today);
  }

  planProposal(): PlanProposal & { inputRevision?: string } {
    const row = this.database.prepare("SELECT id, status, input_revision AS inputRevision, tasks_json AS tasksJson, changes_json AS changesJson, error, updated_at AS updatedAt, plan_date AS planDate FROM plan_proposals WHERE singleton=1").get() as {
      id: string; status: PlanProposal["status"]; inputRevision: string; tasksJson: string; changesJson: string; error: string | null; updatedAt: string; planDate: string | null;
    } | undefined;
    if (!row) return { status: "idle", changes: [] };
    return {
      id: row.id,
      status: row.status,
      ...(row.planDate ? { planDate: row.planDate } : {}),
      inputRevision: row.inputRevision,
      ...(row.status === "ready" ? { tasks: parse(row.tasksJson, [] as PlanTask[]) } : {}),
      changes: parse(row.changesJson, [] as PlanProposalChange[]),
      ...(row.error ? { error: row.error } : {}),
      updatedAt: row.updatedAt,
    };
  }

  beginPlanProposal(inputRevision: string, planDate = this.today()): string {
    const id = crypto.randomUUID();
    this.database.prepare(`INSERT INTO plan_proposals
      (singleton,id,status,input_revision,tasks_json,changes_json,error,updated_at,plan_date)
      VALUES (1,?,'generating',?,'[]','[]',NULL,?,?)
      ON CONFLICT(singleton) DO UPDATE SET id=excluded.id, status='generating', input_revision=excluded.input_revision,
        tasks_json='[]', changes_json='[]', error=NULL, updated_at=excluded.updated_at, plan_date=excluded.plan_date`)
      .run(id, inputRevision, utcNow(), planDate);
    return id;
  }

  beginPlanProposalIfIdle(inputRevision: string, planDate: string, options: { retryFailed?: boolean; recoverStaleBefore?: string } = {}): string | undefined {
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const row = this.database.prepare("SELECT status, plan_date AS planDate, updated_at AS updatedAt FROM plan_proposals WHERE singleton=1").get() as { status: PlanProposal["status"]; planDate: string | null; updatedAt: string } | undefined;
      if (row?.planDate === planDate) {
        const recover = row.status === "generating" && options.recoverStaleBefore !== undefined && row.updatedAt < options.recoverStaleBefore;
        const retry = row.status === "failed" && options.retryFailed === true;
        if (!recover && !retry) { this.database.exec("ROLLBACK;"); return undefined; }
      }
      const id = crypto.randomUUID();
      this.database.prepare(`INSERT INTO plan_proposals
        (singleton,id,status,input_revision,tasks_json,changes_json,error,updated_at,plan_date)
        VALUES (1,?,'generating',?,'[]','[]',NULL,?,?)
        ON CONFLICT(singleton) DO UPDATE SET id=excluded.id, status='generating', input_revision=excluded.input_revision,
          tasks_json='[]', changes_json='[]', error=NULL, updated_at=excluded.updated_at, plan_date=excluded.plan_date`)
        .run(id, inputRevision, utcNow(), planDate);
      this.database.exec("COMMIT;");
      return id;
    } catch (error) { this.database.exec("ROLLBACK;"); throw error; }
  }

  completePlanProposal(id: string, tasks: PlanTask[], changes: PlanProposalChange[]): boolean {
    const result = this.database.prepare(`UPDATE plan_proposals SET status='ready', tasks_json=?, changes_json=?, error=NULL, updated_at=?
      WHERE singleton=1 AND id=? AND status='generating'`)
      .run(JSON.stringify(tasks), JSON.stringify(changes), utcNow(), id);
    return Number(result.changes) === 1;
  }

  planProposalTasks(id: string): PlanTask[] | undefined {
    const row = this.database.prepare("SELECT tasks_json AS tasksJson FROM plan_proposals WHERE singleton=1 AND id=? AND status='ready'").get(id) as { tasksJson: string } | undefined;
    return row ? parse(row.tasksJson, [] as PlanTask[]) : undefined;
  }

  failPlanProposal(id: string, message: string): boolean {
    const result = this.database.prepare(`UPDATE plan_proposals SET status='failed', error=?, updated_at=?
      WHERE singleton=1 AND id=? AND status='generating'`)
      .run(message.slice(0, 240), utcNow(), id);
    return Number(result.changes) === 1;
  }

  failReadyPlanProposal(id: string, message: string): boolean {
    const result = this.database.prepare(`UPDATE plan_proposals SET status='failed', error=?, updated_at=?
      WHERE singleton=1 AND id=? AND status='ready'`)
      .run(message.slice(0, 240), utcNow(), id);
    return Number(result.changes) === 1;
  }

  dismissPlanProposal(id: string): boolean {
    const result = this.database.prepare(`UPDATE plan_proposals SET status='dismissed', updated_at=?
      WHERE singleton=1 AND id=? AND status='ready'`)
      .run(utcNow(), id);
    return Number(result.changes) === 1;
  }

  applyPlanProposal(id: string): boolean {
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const proposal = this.database.prepare("SELECT tasks_json,plan_date AS planDate FROM plan_proposals WHERE singleton=1 AND id=? AND status='ready'").get(id) as { tasks_json: string; planDate: string } | undefined;
      if (!proposal) { this.database.exec("ROLLBACK;"); return false; }
      const tasks = parse(proposal.tasks_json, [] as PlanTask[]);
      const planDate = proposal.planDate || this.today();
      this.database.prepare("UPDATE plan_tasks SET status='expired' WHERE date<? AND status='pending'").run(planDate);
      this.database.prepare("DELETE FROM plan_tasks WHERE date=? AND locked=0 AND status='pending'").run(planDate);
      const insert = this.database.prepare(`INSERT INTO plan_tasks
        (id,date,activity_id,plugin_id,kind,title,description,minutes,reason,review_question_ids_json,question_ids_json,focus_skill_tag,question_kind,locked,status,revision)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,'pending',?)`);
      const revision = utcNow();
      for (const item of tasks) insert.run(item.id,item.date,item.activityId,item.pluginId,item.kind,item.title,item.description,item.minutes,item.reason,JSON.stringify(item.reviewQuestionIds ?? []),JSON.stringify(item.questionIds ?? []),item.focusSkillTag ?? null,item.questionKind ?? null,revision);
      const updated = this.database.prepare("UPDATE plan_proposals SET status='confirmed', updated_at=? WHERE singleton=1 AND id=? AND status='ready'").run(revision, id);
      if (Number(updated.changes) !== 1) { this.database.exec("ROLLBACK;"); return false; }
      this.database.exec("COMMIT;");
      return true;
    } catch (error) { this.database.exec("ROLLBACK;"); throw error; }
  }

  setPlanTask(id: string, changes: { locked?: boolean; status?: "pending" | "done" }): PlanTask | undefined {
    if (changes.locked !== undefined) this.database.prepare("UPDATE plan_tasks SET locked=? WHERE id=?").run(Number(changes.locked), id);
    if (changes.status !== undefined) this.database.prepare("UPDATE plan_tasks SET status=? WHERE id=?").run(changes.status, id);
    return this.planRows(`SELECT id,date,activity_id AS activityId,plugin_id AS pluginId,kind,title,description,minutes,reason,
      review_question_ids_json AS reviewQuestionIdsJson,question_ids_json AS questionIdsJson,focus_skill_tag AS focusSkillTag,question_kind AS questionKind,locked,status
      FROM plan_tasks WHERE id=? LIMIT 1`, id)[0];
  }

  addCoachMessage(conversationId: string, role: CoachMessage["role"], text: string, questionId?: string): CoachMessage {
    const message: CoachMessage = { id: crypto.randomUUID(), conversationId, role, text: text.slice(0, 8000), createdAt: utcNow() };
    this.database.prepare("INSERT INTO coach_messages VALUES (?, ?, ?, ?, ?, ?)").run(message.id, conversationId, role, message.text, message.createdAt, questionId ?? null);
    return message;
  }

  coachHistory(conversationId: string): CoachMessage[] {
    const rows = this.database.prepare("SELECT id, conversation_id AS conversationId, role, text, created_at AS createdAt FROM coach_messages WHERE conversation_id=? ORDER BY created_at DESC LIMIT 20").all(conversationId) as unknown as CoachMessage[];
    return rows.reverse();
  }

  today(): string {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  }

  private dateAfter(days: number): string {
    const next = new Date(`${this.today()}T12:00:00+08:00`);
    next.setDate(next.getDate() + days);
    return next.toISOString().slice(0, 10);
  }

  close(): void { this.database.close(); }
}

