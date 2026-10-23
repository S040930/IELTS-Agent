import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { HttpError, errorResponse } from "./http-error.js";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { realpath } from "node:fs/promises";
import { basename, extname, join, resolve, sep } from "node:path";
import type { Activity, ActivityMode, AnswerDraft, BootstrapData, LearnerProfile, PlanProposal, PlanTask, Question } from "../src/shared/domain.js";
import { LearningStore } from "./db.js";
import type { LearningRepository } from "./store-contract.js";
import { PluginRegistry, toPublicActivity } from "./plugins/registry.js";
import { CoachService } from "./services/coach.js";
import { AiClient } from "./services/ai-client.js";
import { AiPlanner, diffPlan, type PlanningInput } from "./services/ai-planner.js";
import { buildPlanningUnits, completeQuestionGroups, expandQuestionGroups } from "./services/planning-units.js";
import { composeMock, isMockActivityId, listCompleteMocks, mockTiming } from "./services/mock-sets.js";
import { assertActivity } from "../src/shared/validation.js";

export interface ServerOptions {
  dataDirectory?: string;
  pluginDirectory?: string;
  production?: boolean;
  aiClient?: AiClient;
  store?: LearningRepository;
  activities?: Activity[];
  mediaReader?: (pathname: string, range?: string) => Promise<{ stream: NodeJS.ReadableStream; size: number; contentType: string; status?: number; headers?: Record<string, string> } | undefined>;
  waitUntil?: (promise: Promise<unknown>) => void;
  registry?: PluginRegistry;
  deferStartupPlanning?: boolean;
  cloudCatalog?: boolean;
}

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".wav": "audio/wav", ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4", ".ogg": "audio/ogg", ".webm": "audio/webm", ".woff2": "font/woff2"
};

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "x-server-time": String(Date.now()) });
  res.end(JSON.stringify(payload));
}

async function pipeResponse(stream: NodeJS.ReadableStream, res: ServerResponse, label: string): Promise<void> {
  try {
    await pipeline(stream, res);
  } catch (error) {
    if (!res.headersSent) throw error;
    console.error(`[stream:${label}] ${error instanceof Error ? error.message : String(error)}`);
    res.destroy();
  }
}

async function readJson(req: IncomingMessage, maxBytes = 1_500_000): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const data of req) {
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
    size += chunk.byteLength;
    if (size > maxBytes) throw new HttpError("提交的内容过大，请缩小文件后重试。", 413);
    chunks.push(chunk);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch { throw new HttpError("请求内容不是有效 JSON。"); }
}

function requiredString(data: Record<string, unknown>, key: string, maxLength = 4000): string {
  const value = data[key];
  if (typeof value !== "string" || value.length > maxLength) throw new HttpError("请求字段「" + key + "」无效。");
  return value;
}

function cleanAnswers(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError("答案格式无效。");
  const result: Record<string, string> = {};
  for (const [id, answer] of Object.entries(value)) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(id) || typeof answer !== "string" || answer.length > 1000) throw new HttpError("答案包含无效题目或过长文字。");
    result[id] = answer;
  }
  return result;
}

function cleanQuestionTimes(value: unknown, allowedIds: Set<string>): Record<string, number> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError("逐题用时格式无效。");
  const result: Record<string, number> = {};
  for (const [id, seconds] of Object.entries(value)) {
    if (!allowedIds.has(id) || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(id) || typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0 || seconds > 86_400) {
      throw new HttpError("逐题用时包含无效题目或时长。");
    }
    result[id] = seconds;
  }
  return result;
}

function publicActivityForQuestions(activity: Activity, selectedIds?: string[]): ReturnType<typeof toPublicActivity> {
  if (!selectedIds?.length) return toPublicActivity(activity);
  const selected = new Set(selectedIds);
  return toPublicActivity({ ...activity, questions: activity.questions.filter((question) => selected.has(question.id)) });
}

function activityQuestionScope(draft: AnswerDraft, activity: Activity): string[] {
  if (draft.questionIds?.length) return draft.questionIds;
  if (draft.reviewQuestionIds?.length) return draft.reviewQuestionIds;
  return activity.questions.map((question) => question.id);
}

function isSafeDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(value + "T00:00:00.000Z");
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function publicBootstrap(data: BootstrapData): BootstrapData { return data; }

export async function createApp(options: ServerOptions = {}): Promise<{
  server: Server; store: LearningRepository; registry: PluginRegistry; handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>; ensurePlan: (recoverStale?: boolean) => Promise<void>; waitForBackgroundJobs: () => Promise<void>; close: () => Promise<void>;
}> {
  const projectRoot = process.cwd();
  const dataDirectory = resolve(options.dataDirectory ?? process.env.IELTS_DATA_DIR ?? join(projectRoot, ".data"));
  const mediaDirectory = join(dataDirectory, "media");
  if (!options.store) mkdirSync(mediaDirectory, { recursive: true });
  const store = options.store ?? new LearningStore(join(dataDirectory, "learning.sqlite"));
  const pluginRoot = resolve(options.pluginDirectory ?? join(projectRoot, "plugins"));
  const registry = options.registry ?? new PluginRegistry(pluginRoot);
  if (!options.registry) await registry.loadAll();
  for (const failure of registry.failures) console.error(`[plugin:${failure.name}] ${failure.reason}`);
  const contentPath = join(dataDirectory, "content", "activities.json");
  let packagedActivities: Activity[] = options.activities ?? [];
  if (!options.activities && existsSync(contentPath)) {
    try {
      const catalog = JSON.parse(readFileSync(contentPath, "utf8")) as { version?: unknown; activities?: unknown };
      if (catalog.version !== 1 || !Array.isArray(catalog.activities)) throw new Error("题库清单格式无效");
      const seenIds = new Set<string>();
      for (const candidate of catalog.activities) {
        try {
          assertActivity(candidate);
          const activity = candidate as Activity;
          if (seenIds.has(activity.id)) throw new Error(`练习 ID 重复：${activity.id}`);
          if (!registry.activeManifests().some((manifest) => manifest.section === activity.pluginId)) throw new Error(`缺少对应能力模块：${activity.pluginId}`);
          const audioUrls = [activity.audioUrl, ...(activity.audioSections ?? []).map((section) => section.audioUrl)].filter((url): url is string => Boolean(url));
          for (const url of audioUrls) {
            const match = url.match(/^\/media\/([a-f0-9-]{36}\.(?:wav|m4a|mp3|ogg|webm))$/i);
            if (!match || !existsSync(join(mediaDirectory, match[1]!))) throw new Error(`练习「${activity.title}」的音频文件缺失或路径无效：${url}`);
          }
          seenIds.add(activity.id);
          packagedActivities.push(activity);
        } catch (error) {
          console.error(`[content-catalog] ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } catch (error) {
      console.error(`[content-catalog] ${error instanceof Error ? error.message : String(error)}`);
      packagedActivities = [];
    }
  } else if (!options.activities) {
    console.warn(`[content-catalog] 题库未安装：${contentPath}`);
  }
  const ai = options.aiClient ?? new AiClient();
  const coach = new CoachService(store, registry, () => packagedActivities, ai);
  const planner = new AiPlanner(ai);
  const production = options.production ?? process.env.NODE_ENV === "production";
  const webRoot = resolve(projectRoot, "dist");

  const builtinActivities = registry.builtinActivities().filter((activity) =>
    !(options.cloudCatalog && activity.pluginId === "listening"),
  );
  const activities = (): Activity[] => [...builtinActivities, ...packagedActivities];
  const backgroundJobs = new Set<Promise<void>>();

  async function planningInput(profile: LearnerProfile, today: string): Promise<PlanningInput> {
    const [currentPlan, evidence, reviews, attemptedQuestionIds, timingSamples, overdueTasks] = await Promise.all([
      store.plan(today), store.evidence(), store.reviews(today), store.attemptedQuestionIds(), store.questionTimingSamples(), store.overduePlanTasks(today),
    ]);
    const availableActivities = activities().filter((activity) => activity.pluginId === "reading" || activity.pluginId === "listening");
    const dueReviews = reviews.filter((review) => (review.pluginId === "reading" || review.pluginId === "listening") && availableActivities.some((activity) => activity.id === review.activityId));
    const fixedTasks = currentPlan.filter((task) => task.locked || task.status === "done");
    const fixedQuestions = new Set(fixedTasks.flatMap((task) => (task.questionIds ?? []).map((id) => task.activityId + ":" + id)));
    const units = buildPlanningUnits({ activities: availableActivities, attemptedQuestionIds, timingSamples, evidence, dueReviews })
      .filter((unit) => !unit.questionIds.some((id) => fixedQuestions.has(unit.activityId + ":" + id)));
    return {
      today,
      profile: { targetListening: profile.targetListening, targetReading: profile.targetReading, examDate: profile.examDate, dailyMinutes: profile.dailyMinutes },
      evidence,
      units,
      currentTasks: currentPlan.filter((task) => !task.locked && task.status === "pending"),
      fixedTasks,
      overdueTasks,
      requiredBaselineSections: [...new Set(units.filter((unit) => unit.taskKind === "diagnostic" && unit.novelty === "fresh").map((unit) => unit.pluginId))],
    };
  }

  function planningRevision(input: PlanningInput): string {
    return createHash("sha256").update(JSON.stringify({
      today: input.today, profile: input.profile, evidence: input.evidence, units: input.units,
      fixedTasks: input.fixedTasks, overdueTasks: input.overdueTasks,
    })).digest("hex");
  }

  function schedule(promise: Promise<unknown>): void { options.waitUntil?.(promise); }

  function learnerPlanError(error: unknown, input: PlanningInput): string {
    const message = error instanceof Error ? error.message : "";
    if (!input.units.length) return "当前题库没有可安排的小题组或到期错题。";
    if (message.includes("没有安排可执行") || message.includes("格式") || message.includes("超过每日") || message.includes("无效") || message.includes("小题组") || message.includes("基线")) return "AI 生成的计划没有通过检查，请重试。";
    return "AI 暂时没有给出计划建议，请稍后重试。";
  }

  async function requestAiPlan(retryFailed = false, recoverStale = false): Promise<void> {
    const profile = await store.profile();
    if (!profile.setupComplete) return;
    const today = await store.today();
    const proposal = await store.planProposal();
    // Cheap read avoids historical aggregation for a day that is already settled.
    // The repository still performs the final atomic check after building the input.
    if (proposal.planDate === today && proposal.status !== "idle") {
      const retry = retryFailed && proposal.status === "failed";
      const recover = recoverStale && proposal.status === "generating" && proposal.updatedAt !== undefined
        && Date.parse(proposal.updatedAt) < Date.now() - 120_000;
      if (!retry && !recover) return;
    }
    const input = await planningInput(profile, today);
    const revision = planningRevision(input);
    const id = await store.beginPlanProposalIfIdle(revision, today, {
      retryFailed,
      recoverStaleBefore: recoverStale ? new Date(Date.now() - 120_000).toISOString() : undefined,
    });
    if (!id) return;
    const generation = (async () => {
      try {
        const tasks = await planner.generate(input);
        const changes = diffPlan(input.currentTasks, tasks);
        if (!(await store.completePlanProposal(id, tasks, changes))) console.warn("[ai-planner] 计划结果已过期，已忽略。");
      } catch (error) {
        console.error(`[ai-planner] ${error instanceof Error ? error.message : String(error)}`);
        if (!(await store.failPlanProposal(id, learnerPlanError(error, input)))) console.warn("[ai-planner] 失败结果已过期，已忽略。");
      }
    })();
    backgroundJobs.add(generation);
    schedule(generation);
    void generation.then(() => backgroundJobs.delete(generation), () => backgroundJobs.delete(generation));
  }

  async function publicProposal(): Promise<PlanProposal> {
    const { id, planDate, status, tasks, changes, error, updatedAt } = await store.planProposal();
    const safeError = error?.includes("模型配置") ? "AI 暂时没有给出计划建议，请稍后重试。" : error;
    const recoverable = status === "generating" && Boolean(updatedAt && Date.parse(updatedAt) < Date.now() - 120_000);
    return { ...(id ? { id } : {}), ...(planDate ? { planDate } : {}), status, ...(tasks ? { tasks } : {}), changes, ...(safeError ? { error: safeError } : {}), ...(updatedAt ? { updatedAt } : {}), ...(recoverable ? { recoverable: true } : {}) };
  }

  async function resolveActivity(id: string): Promise<Activity | undefined> {
    if (isMockActivityId(id)) return store.mockPaper(id);
    return activities().find((item) => item.id === id);
  }

  async function makeBootstrap(retryFailed = false, recoverStale = false): Promise<BootstrapData> {
    await requestAiPlan(retryFailed, recoverStale);
    const all = activities();
    const missing = coach.missingSettings();
    const skillLabels: Record<string, string> = {};
    for (const activity of registry.builtinActivities()) {
      for (const question of activity.questions) {
        for (const tag of question.skillTags) skillLabels[tag] = registry.skillLabel(tag);
      }
    }
    const [reviews, profile, plan, evidence, attempts, dueReviews, planProposal] = await Promise.all([store.reviews(), store.profile(), store.plan(), store.evidence(), store.attempts(40), store.dueReviewCount(), publicProposal()]);
    const reviewQueue = reviews.flatMap((review) => {
      const activity = all.find((item) => item.id === review.activityId);
      const question = activity?.questions.find((item) => item.id === review.questionId);
      return question ? [{ ...review, prompt: question.prompt }] : [];
    });
    return publicBootstrap({
      profile,
      activities: all.filter((activity) => !activity.id.startsWith("fullmock:")).map(toPublicActivity),
      plugins: registry.manifestsForBrowser(),
      plan,
      planProposal,
      evidence,
      attempts,
      dueReviews,
      mockAvailability: listCompleteMocks(all),
      aiConfigured: missing.length === 0,
      skillLabels,
      reviewQueue,
    });
  }

  async function sendMutationBootstrap(res: ServerResponse, operation: string): Promise<void> {
    try { sendJson(res, 200, await makeBootstrap()); }
    catch {
      console.error("[api] mutation committed but bootstrap failed");
      sendJson(res, 503, { error: operation + "已保存，但学习空间暂时刷新失败。请重新加载核对状态。", applied: true });
    }
  }

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const parsed = new URL(req.url ?? "/", "http://" + (req.headers.host ?? "127.0.0.1"));
    const path = parsed.pathname;
    const method = req.method ?? "GET";

    if (path === "/api/health" && method === "GET") {
      sendJson(res, 200, { ok: true, node: process.versions.node, sqlite: true });
      return;
    }
    if (path === "/api/auth/session" && method === "GET") { sendJson(res, 200, { authenticated: true }); return; }
    if (path === "/api/auth/login" && method === "POST") { sendJson(res, 200, { authenticated: true }); return; }
    if (path === "/api/auth/logout" && method === "POST") { sendJson(res, 200, { authenticated: true }); return; }
    if (path === "/api/plan-proposals/status" && method === "GET") { sendJson(res, 200, { proposal: await publicProposal() }); return; }
    if (path === "/api/bootstrap" && method === "GET") {
      sendJson(res, 200, await makeBootstrap());
      return;
    }

    const clientEntry = path.match(/^\/(?:api\/)?plugin-assets\/([a-z0-9][a-z0-9._-]{0,63})\/([^/]+)$/);
    if (clientEntry && method === "GET") {
      const [, pluginId, fileName] = clientEntry as unknown as [string, string, string];
      if (pluginId === "shared") {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.mjs$/.test(fileName)) throw new HttpError("共享模块不存在。", 404);
        const pluginsRoot = resolve(options.pluginDirectory ?? join(projectRoot, "plugins"));
        const sharedRoot = resolve(pluginsRoot, "shared");
        const sharedFile = resolve(sharedRoot, fileName);
        if (!existsSync(sharedFile)) throw new HttpError("共享模块不存在。", 404);
        const [rootReal, fileReal] = await Promise.all([realpath(sharedRoot), realpath(sharedFile)]);
        if (fileReal !== rootReal && !fileReal.startsWith(rootReal + sep)) throw new HttpError("共享模块不存在。", 404);
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache", "x-content-type-options": "nosniff" });
        await pipeResponse(createReadStream(fileReal), res, "plugin-shared");
        return;
      }
      const manifest = registry.findManifest(pluginId);
      if (!manifest || basename(manifest.browserEntry) !== fileName) throw new HttpError("插件浏览器入口不存在。", 404);
      const source = await registry.readBrowserEntry(pluginId);
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache", "x-content-type-options": "nosniff" });
      res.end(source);
      return;
    }

    const mediaMatch = path.match(/^\/(?:api\/)?media\/([a-f0-9-]{36}\.(?:wav|m4a|mp3|ogg|webm))$/i);
    if (mediaMatch && method === "GET") {
      if (options.mediaReader) {
        const asset = await options.mediaReader(mediaMatch[1]!, req.headers.range);
        if (!asset) throw new HttpError("音频文件不存在。", 404);
        res.writeHead(asset.status ?? 200, { "content-type": asset.contentType, "content-length": asset.size, "accept-ranges": "bytes", "cache-control": "private, max-age=0, must-revalidate", ...asset.headers });
        await pipeResponse(asset.stream, res, "media-cloud");
        return;
      }
      const file = resolve(mediaDirectory, mediaMatch[1]!);
      if (!file.startsWith(resolve(mediaDirectory) + sep) || !existsSync(file)) throw new HttpError("音频文件不存在。", 404);
      const size = statSync(file).size;
      const range = req.headers.range;
      if (range) {
        const parts = range.match(/^bytes=(\d*)-(\d*)$/);
        if (!parts) { res.writeHead(416, { "content-range": "bytes */" + size }); res.end(); return; }
        const start = parts[1] ? Number(parts[1]) : Math.max(0, size - Number(parts[2] || 0));
        const end = parts[2] && parts[1] ? Math.min(size - 1, Number(parts[2])) : size - 1;
        if (start >= size || end < start) { res.writeHead(416, { "content-range": "bytes */" + size }); res.end(); return; }
        res.writeHead(206, { "content-type": contentTypes[extname(file)] ?? "application/octet-stream", "content-length": end - start + 1, "content-range": "bytes " + start + "-" + end + "/" + size, "accept-ranges": "bytes", "cache-control": "no-store" });
        await pipeResponse(createReadStream(file, { start, end }), res, "media-range");
      } else {
        res.writeHead(200, { "content-type": contentTypes[extname(file)] ?? "application/octet-stream", "content-length": size, "accept-ranges": "bytes", "cache-control": "no-store" });
        await pipeResponse(createReadStream(file), res, "media-full");
      }
      return;
    }

    if (path === "/api/profile" && method === "PUT") {
      const body = await readJson(req, 16_000);
      const listening = Number(body.targetListening);
      const reading = Number(body.targetReading);
      const minutes = Number(body.dailyMinutes);
      const examDate = String(body.examDate ?? "");
      if (![listening, reading].every((score) => Number.isFinite(score) && score >= 1 && score <= 9 && Math.round(score * 2) === score * 2)) throw new HttpError("目标分数请输入 1–9 分，支持 0.5 分为单位。");
      if (!Number.isInteger(minutes) || minutes < 15 || minutes > 180) throw new HttpError("每日学习时间请设为 15–180 分钟。");
      if (!isSafeDate(examDate)) throw new HttpError("请选择有效的考试日期。");
      await store.saveProfile({ targetListening: listening, targetReading: reading, examDate, dailyMinutes: minutes });
      await sendMutationBootstrap(res, "目标");
      return;
    }

    if (path === "/api/plan-proposals/retry" && method === "POST") {
      sendJson(res, 200, await makeBootstrap(true, true));
      return;
    }
    const proposalAction = path.match(/^\/api\/plan-proposals\/([a-z0-9-]+)\/(confirm|dismiss)$/i);
    if (proposalAction && method === "POST") {
      const proposalId = proposalAction[1]!;
      const proposal = await store.planProposal();
      if (proposal.id !== proposalId) throw new HttpError("这份学习方案已更新，请查看最新建议。", 409);
      if (proposal.planDate !== await store.today()) throw new HttpError("这份方案不属于今天，请重新加载查看今日计划。", 409);
      if (proposalAction[2] === "dismiss") {
        if (!(await store.dismissPlanProposal(proposalId))) {
          const current = await store.planProposal();
          if (current.id !== proposalId || current.status !== "dismissed") throw new HttpError("这份方案已经处理或已失效。", 409);
        }
      } else if (!(await store.applyPlanProposal(proposalId))) {
        const current = await store.planProposal();
        if (current.id !== proposalId || (current.status !== "confirmed" && current.status !== "failed")) {
          throw new HttpError("这份方案已经处理或已失效。", 409);
        }
      }
      await sendMutationBootstrap(res, "方案处理结果");
      return;
    }
    const planMatch = path.match(/^\/api\/plans\/([^/]+)$/);
    if (planMatch && method === "PATCH") {
      const body = await readJson(req, 12_000);
      const update: { locked?: boolean; status?: "pending" | "done" } = {};
      if (typeof body.locked === "boolean") update.locked = body.locked;
      if (body.status === "pending" || body.status === "done") update.status = body.status;
      if (!Object.keys(update).length) throw new HttpError("请提供要更新的计划状态。");
      const task = await store.setPlanTask(decodeURIComponent(planMatch[1]!), update);
      if (!task) throw new HttpError("计划任务不存在。", 404);
      await sendMutationBootstrap(res, "任务状态");
      return;
    }

    if (path === "/api/attempts" && method === "POST") {
      const body = await readJson(req, 12_000);
      const activityId = requiredString(body, "activityId", 180);
      const mode = body.mode;
      if (mode !== "practice" && mode !== "mock" && mode !== "review") throw new HttpError("练习模式无效。");
      const activity = await resolveActivity(activityId);
      if (!activity) throw new HttpError("找不到这份练习，请返回首页刷新列表。", 404);
      if (mode === "mock") throw new HttpError("完整模考请从考前准备页面开考。");
      if (isMockActivityId(activityId)) throw new HttpError("整套模考请从完整模考页面进入。");
      const taskId = typeof body.taskId === "string" ? body.taskId : undefined;
      const rawReviewIds = body.reviewQuestionIds;
      const rawQuestionIds = body.questionIds;
      if ((rawReviewIds !== undefined && !Array.isArray(rawReviewIds)) || (rawQuestionIds !== undefined && !Array.isArray(rawQuestionIds))) throw new HttpError("所选题目范围无效。");
      const requestedReviewIds = (rawReviewIds ?? []) as unknown[];
      const requestedQuestionIds = (rawQuestionIds ?? []) as unknown[];
      if (![...requestedReviewIds, ...requestedQuestionIds].every((id) => typeof id === "string")) throw new HttpError("所选题目范围无效。");
      let reviewQuestionIds = requestedReviewIds as string[];
      let questionIds = requestedQuestionIds as string[];
      let reviewTask: PlanTask | undefined;
      if (taskId) {
        const task = (await store.plan()).find((item) => item.id === taskId);
        reviewTask = task;
        if (!task || task.activityId !== activityId || task.status !== "pending" || task.date !== await store.today()) throw new HttpError("这项计划已更新或不属于今天，请刷新后再试。", 409);
        if ((task.kind === "review") !== (mode === "review")) throw new HttpError("练习模式与今日计划不匹配。");
        if (!task.questionIds?.length) throw new HttpError("这项计划没有可练习的题目，请刷新计划或从题库自主练习。", 409);
        if (questionIds.length && JSON.stringify([...questionIds].sort()) !== JSON.stringify([...(task.questionIds ?? [])].sort())) throw new HttpError("所选题目与计划任务不匹配。");
        questionIds = task.questionIds ?? [];
        reviewQuestionIds = task.reviewQuestionIds ?? [];
      }
      if (mode === "review") {
        const requestedReviewIds = reviewQuestionIds.length ? reviewQuestionIds : questionIds;
        if (!requestedReviewIds.length) throw new HttpError("当前没有可以复习的题目。");
        try { questionIds = completeQuestionGroups(activity, requestedReviewIds); }
        catch (error) { throw new HttpError(error instanceof Error ? error.message : "所选题目范围无效。"); }
        const dueCheckIds = reviewTask?.reviewQuestionIds?.length ? reviewTask.reviewQuestionIds : requestedReviewIds;
        const due = await store.reviews();
        const dueIds = new Set(due.filter((item) => item.activityId === activityId).map((item) => item.questionId));
        if (!dueCheckIds.every((id) => dueIds.has(id))) throw new HttpError("错题复习只能选择已经到期的题目。");
      } else if (questionIds.length) {
        try { questionIds = expandQuestionGroups(activity, questionIds); }
        catch (error) { throw new HttpError(error instanceof Error ? error.message : "所选题目范围无效。"); }
      }
      const draft = await store.startAttempt(activityId, mode as ActivityMode, taskId, reviewQuestionIds, questionIds);
      sendJson(res, 201, { draft, activity: publicActivityForQuestions(activity, questionIds), mode });
      return;
    }

    const attemptMatch = path.match(/^\/api\/attempts\/([a-z0-9-]+)(?:\/(draft|hint|submit|interrupt|abandon|cause|transcript|analysis))?$/i);
    if (attemptMatch) {
      const attemptId = attemptMatch[1]!;
      const operation = attemptMatch[2];
      const [draft, completedAttempt] = await Promise.all([store.draft(attemptId), store.attempt(attemptId)]);
      if (method === "GET" && !operation) {
        const attempt = completedAttempt;
        if (attempt) {
          const activity = await resolveActivity(attempt.activityId);
          const selected = attempt.responses.map((response) => response.questionId);
          sendJson(res, 200, { result: attempt, ...(activity ? { activity: publicActivityForQuestions(activity, selected) } : {}) });
          return;
        }
        if (draft) {
          const activity = await resolveActivity(draft.activityId);
          sendJson(res, 200, { draft, ...(activity ? { activity: publicActivityForQuestions(activity, activityQuestionScope(draft, activity)) } : {}) });
          return;
        }
        throw new HttpError("练习记录不存在。", 404);
      }
      if (!draft && !((operation === "cause" || operation === "transcript" || operation === "analysis") && completedAttempt)) {
        if (completedAttempt && operation === "submit" && method === "POST") {
          sendJson(res, 200, { result: completedAttempt, duplicate: true });
          return;
        }
        throw new HttpError("这份练习已结束或找不到记录。", 404);
      }
      const activity = await resolveActivity(draft?.activityId ?? completedAttempt!.activityId);
      if (!activity) throw new HttpError("找不到这份练习，请返回首页刷新列表。", 404);
      if ((operation === "transcript" || operation === "analysis") && method === "GET" && !completedAttempt) {
        throw new HttpError("提交后才能查看听力原文和解析。", 403);
      }
      if (operation === "transcript" && method === "GET") {
        if (activity.pluginId !== "listening") throw new HttpError("这份练习没有听力原文。", 404);
        const audioSections = (activity.audioSections ?? [])
          .map(({ title, transcript }) => ({ title, transcript: typeof transcript === "string" ? transcript : "" }))
          .filter((item) => item.transcript.trim());
        sendJson(res, 200, { transcript: activity.transcript ?? "", audioSections });
        return;
      }
      if (operation === "analysis" && method === "GET") {
        if (activity.pluginId !== "listening") throw new HttpError("这份练习没有听力解析。", 404);
        const allowedIds = new Set(activityQuestionScope(draft ?? completedAttempt!, activity));
        const explanations = activity.questions
          .filter((question) => allowedIds.has(question.id))
          .map((question) => ({
            questionId: question.id,
            displayNumber: question.displayNumber ?? null,
            prompt: question.prompt,
            answer: question.correctAnswer,
            evidence: question.evidence,
            explanation: question.explanation,
          }));
        sendJson(res, 200, { explanations });
        return;
      }
      if (operation === "draft" && (method === "PATCH" || method === "POST")) {
        if (!draft) throw new HttpError("这份练习已结束或找不到记录。", 404);
        const body = await readJson(req, 64_000);
        const allowedIds = new Set(activityQuestionScope(draft, activity));
        const answers = cleanAnswers(body.answers);
        if (Object.keys(answers).some((id) => !allowedIds.has(id))) throw new HttpError("作答包含不属于本次练习的题目。");
        const times = cleanQuestionTimes(body.questionTimeSeconds, allowedIds);
        const revision = body.revision === undefined ? Date.now() : body.revision;
        if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision <= 0) throw new HttpError("草稿保存版本无效。");
        sendJson(res, 200, { draft: await store.saveDraft(attemptId, answers, times, revision) });
        return;
      }
      if (operation === "hint" && method === "POST") {
        if (!draft) throw new HttpError("这份练习已结束或找不到记录。", 404);
        if (draft.mode === "mock") throw new HttpError("完整模考期间先独立作答，提交后可以和导师一起复盘。", 403);
        const body = await readJson(req, 12_000);
        const questionId = requiredString(body, "questionId", 64);
        if (!activityQuestionScope(draft, activity).includes(questionId)) throw new HttpError("这道题不属于本次练习。");
        const question = activity.questions.find((item) => item.id === questionId);
        if (!question) throw new HttpError("找不到这道题。", 404);
        await store.addHint(attemptId, questionId);
        sendJson(res, 200, { hint: coach.hint(activity, question), questionId });
        return;
      }
      if (operation === "interrupt" && method === "POST") {
        if (!draft) throw new HttpError("这份练习已结束或找不到记录。", 404);
        const body = await readJson(req, 12_000);
        const reason = typeof body.reason === "string" ? body.reason : "浏览器页面中断";
        await store.markInterrupted(attemptId, reason);
        sendJson(res, 200, { ok: true });
        return;
      }
      if (operation === "abandon" && method === "POST") {
        if (!draft) throw new HttpError("这份练习已结束或找不到记录。", 404);
        await store.abandonAttempt(attemptId);
        sendJson(res, 200, { ok: true });
        return;
      }
      if (operation === "submit" && method === "POST") {
        if (!draft) throw new HttpError("这份练习已结束或找不到记录。", 404);
        const body = await readJson(req, 64_000);
        const selectedIds = activityQuestionScope(draft, activity);
        const allowedIds = new Set(selectedIds);
        const answers = body.answers === undefined ? draft.answers : cleanAnswers(body.answers);
        if (Object.keys(answers).some((id) => !allowedIds.has(id))) throw new HttpError("作答包含不属于本次练习的题目。");
        const times = cleanQuestionTimes(body.questionTimeSeconds, allowedIds);
        const mergedTimes = { ...(draft.questionTimeSeconds ?? {}) };
        for (const [id, seconds] of Object.entries(times ?? {})) mergedTimes[id] = Math.max(mergedTimes[id] ?? 0, seconds);
        const latestDraft: AnswerDraft = { ...draft, answers, questionTimeSeconds: mergedTimes };
        const selectedQuestions = draft.questionIds?.length || draft.reviewQuestionIds?.length
          ? activity.questions.filter((question) => selectedIds.includes(question.id))
          : activity.questions;
        const gradedActivity = { ...activity, questions: selectedQuestions };
        const grader = registry.grader(activity.pluginId);
        if (!grader) throw new HttpError("这项练习暂时无法评分，请稍后再试。", 503);
        const responses = grader(gradedActivity, latestDraft.answers, latestDraft.hintedQuestionIds).map((response) => ({
          ...response,
          materialId: activity.examParts?.find((part) => part.questionIds.includes(response.questionId))?.sourceActivityId ?? response.materialId,
        }));
        const result = await store.submitDraft(latestDraft, gradedActivity, responses);
        sendJson(res, 200, { result });
        return;
      }
      if (operation === "cause" && method === "POST") {
        const body = await readJson(req, 12_000);
        const questionId = requiredString(body, "questionId", 64);
        const skillTag = requiredString(body, "skillTag", 100);
        const cause = requiredString(body, "cause", 120);
        const previous = await store.attempt(attemptId);
        const response = previous?.responses.find((item) => item.questionId === questionId);
        if (!response || response.correct || !response.skillTags.includes(skillTag)) throw new HttpError("只能确认这次错题关联的能力原因。");
        await store.saveCause(attemptId, questionId, skillTag, cause);
        sendJson(res, 200, await makeBootstrap());
        return;
      }
      throw new HttpError("此练习操作不受支持。", 405);
    }

    if (path === "/api/mock/available" && method === "GET") {
      sendJson(res, 200, { sets: listCompleteMocks(activities()) });
      return;
    }
    if (path === "/api/mock/prepare" && method === "POST") {
      const body = await readJson(req, 12_000);
      if (body.section !== "reading" && body.section !== "listening") throw new HttpError("请选择听力或阅读模考。");
      const activity = composeMock(body.section, randomUUID(), activities());
      if (!activity) throw new HttpError("缺少可组合为 40 题的完整机考材料。");
      await store.saveMockPaper(activity);
      sendJson(res, 201, { activity: toPublicActivity(activity) });
      return;
    }
    if (path === "/api/mock/start" && method === "POST") {
      const body = await readJson(req, 12_000);
      const section = body.section;
      const mockId = requiredString(body, "mockId", 100);
      if (section !== "reading" && section !== "listening") throw new HttpError("请选择听力或阅读模考。");
      const activity = await store.mockPaper(`fullmock:${section}:${mockId}`);
      if (!activity) throw new HttpError("找不到已准备的试卷，请重新进入考前准备。", 404);
      let timing;
      try { timing = mockTiming(activity, body.audioDurationsSeconds); }
      catch (reason) { throw new HttpError(reason instanceof Error ? reason.message : "音频预检未完成。"); }
      const draft = await store.startAttempt(activity.id, "mock", undefined, undefined, undefined, timing);
      sendJson(res, 201, { draft, activity: toPublicActivity(activity), mode: "mock" });
      return;
    }

    if (path === "/api/coach" && method === "POST") {
      const body = await readJson(req, 24_000);
      const conversationId = requiredString(body, "conversationId", 64);
      const activityId = requiredString(body, "activityId", 180);
      const questionId = requiredString(body, "questionId", 64);
      const userText = requiredString(body, "message", 2000).trim();
      const activity = await resolveActivity(activityId);
      if (!activity || !userText) throw new HttpError("找不到当前练习或问题内容为空。");
      const attemptId = typeof body.attemptId === "string" ? body.attemptId : "";
      const activeDraft = await store.draftForActivity(activityId);
      if (activeDraft?.mode === "mock") throw new HttpError("完整模考结束前，导师侧栏会暂停对话。提交后可以一起复盘。", 403);
      const [draft, completed] = attemptId ? await Promise.all([store.draft(attemptId), store.attempt(attemptId)]) : [undefined, undefined];
      if (attemptId && !draft && !completed) throw new HttpError("找不到这次练习记录。", 404);
      if (draft && draft.activityId !== activityId) throw new HttpError("这次练习与当前材料不匹配。", 403);
      if (completed && completed.activityId !== activityId) throw new HttpError("这次练习与当前材料不匹配。", 403);
      if (isMockActivityId(activityId)) {
        if (!completed) throw new HttpError("完整模考提交后才能和导师复盘。", 403);
        if (!completed.responses.some((item) => item.questionId === questionId)) throw new HttpError("这道题不在本次模考提交记录中。", 403);
      }
      const question = activity.questions.find((item) => item.id === questionId);
      if (!question) throw new HttpError("找不到当前题目。", 404);
      if (draft && !activityQuestionScope(draft, activity).includes(questionId)) throw new HttpError("这道题不属于本次练习。");
      if (completed && !activityQuestionScope(completed, activity).includes(questionId)) throw new HttpError("这道题不属于这次已提交的练习。");
      const response = completed?.activityId === activityId ? completed.responses.find((item) => item.questionId === questionId) : undefined;
      const snapshot = await coach.snapshot(activity, question, draft, draft?.mode ?? completed?.mode ?? "practice", response);
      const latest = await store.addCoachMessage(conversationId, "user", userText, questionId);
      const history = (await store.coachHistory(conversationId)).filter((item) => item.id !== latest.id).map((item) => ({ role: item.role, content: item.text }));
      let reply: string;
      try {
        reply = await coach.reply(userText, history, snapshot);
      } catch (error) {
        console.error(`[coach] ${error instanceof Error ? error.message : String(error)}`);
        throw new HttpError("学习导师暂时无法回复，请稍后重试。", 503);
      }
      const message = await store.addCoachMessage(conversationId, "assistant", reply, questionId);
      sendJson(res, 200, { message });
      return;
    }
    if (path === "/api/coach/history" && method === "GET") {
      const conversationId = parsed.searchParams.get("conversationId") ?? "";
      if (!/^[a-zA-Z0-9-]{1,64}$/.test(conversationId)) throw new HttpError("conversationId 无效。");
      sendJson(res, 200, { messages: await store.coachHistory(conversationId) });
      return;
    }

    if (production && method === "GET" && !path.startsWith("/api/")) {
      await serveWebFile(res, webRoot, path);
      return;
    }
    throw new HttpError("找不到此 API。", 404);
  };

  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      if (res.headersSent) { res.destroy(error instanceof Error ? error : undefined); return; }
      const failure = errorResponse(error);
      if (!(error instanceof HttpError)) console.error("[api] request failed");
      sendJson(res, failure.status, failure.body);
    });
  });

  const ensurePlan = (recoverStale = false) => requestAiPlan(false, recoverStale);
  if (!options.deferStartupPlanning) void requestAiPlan(false, true);

  return {
    server, store, registry, handle, ensurePlan,
    waitForBackgroundJobs: async () => { while (backgroundJobs.size) await Promise.allSettled([...backgroundJobs]); },
    close: async () => {
      while (backgroundJobs.size) await Promise.allSettled([...backgroundJobs]);
      await new Promise<void>((resolveClose, rejectClose) => {
        if (!server.listening) { resolveClose(); return; }
        server.close((error) => error ? rejectClose(error) : resolveClose());
      });
      try { await registry.releaseAll(); }
      finally { await store.close(); }
    },
  };
}

async function serveWebFile(res: ServerResponse, webRoot: string, pathname: string): Promise<void> {
  if (!existsSync(webRoot)) throw new HttpError("网页构建文件不存在，请先运行 npm run build。", 503);
  let decoded: string;
  try { decoded = decodeURIComponent(pathname); } catch { throw new HttpError("页面路径无效。", 400); }
  const requested = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const target = resolve(webRoot, requested);
  if (!target.startsWith(resolve(webRoot) + sep)) throw new HttpError("页面路径无效。", 404);
  const file = existsSync(target) && statSync(target).isFile() ? target : resolve(webRoot, "index.html");
  if (!existsSync(file)) throw new HttpError("网页构建文件不存在。", 404);
  res.writeHead(200, {
    "content-type": contentTypes[extname(file)] ?? "application/octet-stream",
    "content-length": statSync(file).size,
    "cache-control": extname(file) === ".html" ? "no-cache" : "public, max-age=86400",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' https:; media-src 'self' blob:; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'"
  });
  await pipeResponse(createReadStream(file), res, "web-file");
}
