import type { LearnerProfile, PlanProposalChange, PlanTask, Section, SkillEvidence } from "../../src/shared/domain.js";
import type { AiClient } from "./ai-client.js";
import type { PlanningUnit } from "./planning-units.js";

export interface PlanningInput {
  today: string;
  profile: Pick<LearnerProfile, "targetListening" | "targetReading" | "examDate" | "dailyMinutes">;
  evidence: SkillEvidence[];
  units: PlanningUnit[];
  currentTasks: PlanTask[];
  fixedTasks: PlanTask[];
  overdueTasks: PlanTask[];
  requiredBaselineSections: Array<"reading" | "listening">;
}

function taskKey(task: PlanTask): string {
  return [task.date, task.activityId, task.kind, [...(task.questionIds ?? [])].sort().join(",")].join("|");
}

export function diffPlan(current: PlanTask[], proposed: PlanTask[]): PlanProposalChange[] {
  const oldByKey = new Map(current.map((task) => [taskKey(task), task]));
  const newByKey = new Map(proposed.map((task) => [taskKey(task), task]));
  const changes: PlanProposalChange[] = [];
  for (const [key, before] of oldByKey) {
    const after = newByKey.get(key);
    if (!after) changes.push({ kind: "removed", before });
    else if (before.reason !== after.reason) changes.push({ kind: "updated", before, after });
  }
  for (const [key, after] of newByKey) if (!oldByKey.has(key)) changes.push({ kind: "added", after });
  return changes.sort((a, b) => (a.after?.date ?? a.before?.date ?? "").localeCompare(b.after?.date ?? b.before?.date ?? ""));
}

export class AiPlanner {
  constructor(private readonly ai: AiClient) {}

  async generate(input: PlanningInput): Promise<PlanTask[]> {
    if (!input.units.length) throw new Error("当前题库没有可安排的小题组。");
    const messages = [
      { role: "system" as const, content: [
        "你是学术类 IELTS 听力与阅读的每日个性化学习规划器。只生成 today 这一天的一份小题组计划。",
        "只能从 units 选择 unitId；unit 已包含真实材料 ID、完整关联题组的题目 ID、题型、能力标签、题量和服务端估算的分钟数。不得改题目范围、分钟数或任务类型。",
        "模型输入不含题干、答案、解析、录音文本或导师对话；你也不得生成这些内容。",
        "优先安排到期错题复习；其次安排近 30 天独立表现偏低、提示比例较高或有已确认错因的能力；证据不足时安排 diagnostic 基线小题组，不要把证据不足写成弱项。",
        "novelty=fresh 表示题组此前没有独立作答过，优先用它建立基线和验证迁移；revisit 只在没有足够新题或确有巩固价值时使用。review 是错题复习，不能当作新题迁移证据。",
        "requiredBaselineSections 中的科目今天至少安排一个 diagnostic 小题组（若 units 中存在该科 fresh diagnostic）。兼顾听力和阅读，但不得为了凑数安排低价值任务。",
        "overdueTasks 是昨天或更早未完成的旧任务。逐项重新评估：只有仍能在今天的题库候选中找到合适目标、且符合今天时间预算时才重排；不要原样全部顺延。",
        "固定任务 fixedTasks 必须保留且不能重复输出；当前未锁定任务 currentTasks 供比较，可以保留也可根据新日程重新选择。",
        "按考试日期、目标分数、证据数量和每日分钟安排少量明确任务。所有任务分钟之和加固定任务分钟不得超过 dailyMinutes。优先短而聚焦的小题组。",
        "reason 用简体中文，说明训练重点及安排依据；证据不足时明确说这是建立基线或待验证，不得臆测薄弱点。",
        "只输出严格 JSON：{\"tasks\":[{\"unitId\":\"候选 ID\",\"reason\":\"具体中文安排理由\"}]}。不得输出日期、题目列表、任务类型或分钟数；这些由服务端从候选恢复。",
      ].join("\n") },
      { role: "user" as const, content: JSON.stringify(input) },
    ];
    const text = await this.ai.complete(messages, { temperature: 0.2, maxTokens: 6000, timeoutMs: 45_000, reasoningEffort: "low" });
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { throw new Error("AI 返回的计划格式无法识别。"); }
    return validatePlan(parsed, input);
  }
}

export function validatePlan(value: unknown, input: PlanningInput): PlanTask[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("AI 返回的计划格式无法识别。");
  const rawTasks = (value as { tasks?: unknown }).tasks;
  if (!Array.isArray(rawTasks) || rawTasks.length === 0) throw new Error("AI 没有安排可执行的学习任务。");
  const units = new Map(input.units.map((unit) => [unit.id, unit]));
  const usedIds = new Set<string>();
  const usedQuestions = new Set<string>();
  const usedDueReviews = new Set<string>();
  let minutes = input.fixedTasks.reduce((sum, task) => sum + task.minutes, 0);
  const tasks: PlanTask[] = [];
  for (const candidate of rawTasks) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("AI 返回的计划包含无效任务。");
    const raw = candidate as Record<string, unknown>;
    if (typeof raw.unitId !== "string" || typeof raw.reason !== "string" || !raw.reason.trim() || raw.reason.length > 240) throw new Error("AI 返回的任务缺少有效候选 ID 或安排理由。");
    if (usedIds.has(raw.unitId)) throw new Error("AI 返回的计划重复安排了同一小题组。");
    const unit = units.get(raw.unitId);
    if (!unit) throw new Error("AI 返回的计划引用了无效或未加载的小题组。");
    if (!unit.questionIds.length || new Set(unit.questionIds).size !== unit.questionIds.length) throw new Error("候选小题组含有重复或空题目 ID。");
    if (unit.taskKind === "review" && !unit.dueReviewQuestionIds?.length) throw new Error("错题复习候选没有到期题目。");
    for (const questionId of unit.questionIds) {
      const key = `${unit.activityId}:${questionId}`;
      if (usedQuestions.has(key)) throw new Error("AI 返回的计划重复安排了同一道题。");
      usedQuestions.add(key);
    }
    for (const questionId of unit.dueReviewQuestionIds ?? []) {
      const key = `${unit.activityId}:${questionId}`;
      if (usedDueReviews.has(key)) throw new Error("AI 返回的计划重复安排了同一道到期错题。");
      usedDueReviews.add(key);
    }
    usedIds.add(unit.id);
    minutes += unit.minutes;
    if (minutes > input.profile.dailyMinutes) throw new Error("AI 返回的计划超过每日学习时间。");
    tasks.push({
      id: crypto.randomUUID(), date: input.today, activityId: unit.activityId, pluginId: unit.pluginId as Section,
      kind: unit.taskKind, title: unit.title,
      description: `${unit.questionCount} 道${questionKindText(unit.questionKind)}题 · ${unit.novelty === "review" ? "到期错题" : unit.novelty === "fresh" ? "新题" : "巩固练习"} · 约 ${unit.minutes} 分钟`,
      minutes: unit.minutes, reason: raw.reason.trim(), questionIds: [...unit.questionIds], focusSkillTag: unit.focusSkillTag,
      questionKind: unit.questionKind, ...(unit.dueReviewQuestionIds?.length ? { reviewQuestionIds: [...unit.dueReviewQuestionIds] } : {}),
      locked: false, status: "pending",
    });
  }
  const plannedSections = new Set(tasks.filter((task) => task.kind === "diagnostic").map((task) => task.pluginId));
  for (const section of input.requiredBaselineSections) {
    if (!plannedSections.has(section) && input.units.some((unit) => unit.pluginId === section && unit.taskKind === "diagnostic" && unit.novelty === "fresh")) {
      throw new Error("AI 返回的计划没有为证据不足的科目安排基线小题组。");
    }
  }
  return tasks.sort((a, b) => a.pluginId.localeCompare(b.pluginId) || a.title.localeCompare(b.title));
}

function questionKindText(kind: PlanningUnit["questionKind"]): string {
  return kind === "choice" ? "选择" : kind === "tfng" ? "判断" : "填空";
}

export function fitsDailyBudget(tasks: PlanTask[], fixedTasks: PlanTask[], dailyMinutes: number): boolean {
  return tasks.reduce((sum, task) => sum + task.minutes, 0) + fixedTasks.reduce((sum, task) => sum + task.minutes, 0) <= dailyMinutes;
}
