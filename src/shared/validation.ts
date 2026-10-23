import type { Activity, PluginManifest, Question, Section } from "./domain.js";

const sectionIds = new Set<Section>(["reading", "listening", "vocabulary"]);
const safeId = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const isSafeId = (value: unknown): value is string => typeof value === "string" && safeId.test(value);
const isText = (value: unknown, max: number) => typeof value === "string" && value.trim().length > 0 && value.length <= max;
const audioPath = (value: unknown) => typeof value === "string" && !value.includes("..") && (/^\/[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(value) || /^https:\/\//.test(value));
/**
 * 这些题型的选项必须带列表正文——练习页要把它渲染在字母旁边。
 * reading.matching-information（段落题）不在其中：它的选项本来就只是段落字母 A–H。
 */
const textRequiredTags = new Set([
  "reading.matching-features",
  "reading.classification",
  "reading.matching-sentence-endings",
]);

export function assertManifest(value: unknown): asserts value is PluginManifest {
  if (!value || typeof value !== "object") throw new Error("插件声明必须是对象");
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || !safeId.test(row.id)) throw new Error("插件 ID 无效");
  if (typeof row.name !== "string" || row.name.length > 100) throw new Error("插件名称无效");
  if (typeof row.version !== "string" || !/^\d+\.\d+\.\d+/.test(row.version)) throw new Error("插件版本无效");
  if (row.sdkVersion !== 1) throw new Error("不支持的插件 SDK 版本");
  if (typeof row.section !== "string" || !sectionIds.has(row.section as Section)) throw new Error("插件区块无效");
  if (typeof row.serverEntry !== "string" || row.serverEntry.startsWith("/") || row.serverEntry.includes("..")) throw new Error("服务端入口无效");
  if (typeof row.browserEntry !== "string" || !row.browserEntry.startsWith("./") || row.browserEntry.includes("..")) throw new Error("浏览器入口无效");
  if (!Array.isArray(row.capabilities) || row.capabilities.some((cap) => typeof cap !== "string")) throw new Error("插件能力列表无效");
  if (row.dependencies !== undefined && (!row.dependencies || typeof row.dependencies !== "object" || Array.isArray(row.dependencies) || Object.entries(row.dependencies).some(([id, version]) => !safeId.test(id) || typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)))) throw new Error("插件依赖必须声明为插件 ID 到精确版本的映射");
}

export function assertQuestion(value: unknown): asserts value is Question {
  if (!value || typeof value !== "object") throw new Error("题目必须是对象");
  const question = value as Record<string, unknown>;
  if (typeof question.id !== "string" || !safeId.test(question.id)) throw new Error("题号无效");
  if (typeof question.prompt !== "string" || question.prompt.trim().length === 0 || question.prompt.length > 1600) throw new Error("题目内容无效");
  if (typeof question.kind !== "string" || !["choice", "tfng", "completion"].includes(question.kind)) throw new Error("不支持的题型");
  if (typeof question.correctAnswer !== "string" || !question.correctAnswer.trim()) throw new Error("标准答案缺失");
  if (typeof question.evidence !== "string" || !question.evidence.trim()) throw new Error("答案证据缺失");
  if (!Array.isArray(question.skillTags) || !question.skillTags.length || question.skillTags.some((tag) => typeof tag !== "string")) throw new Error("能力标签缺失");
  if (question.options !== undefined && (!Array.isArray(question.options) || question.options.some((option) => typeof option !== "string"))) throw new Error("题目选项无效");
  if ((question.kind === "choice" || question.kind === "tfng") && (!Array.isArray(question.options) || question.options.length < 2 || question.options.some((option) => typeof option !== "string"))) throw new Error("选择题需要至少两个有效选项");
  if (Array.isArray(question.options) && !question.options.includes(question.correctAnswer)) throw new Error("标准答案不在题目选项中");
  if (question.optionLabels !== undefined && (!question.optionLabels || typeof question.optionLabels !== "object" || Array.isArray(question.optionLabels) || Object.values(question.optionLabels).some((label) => typeof label !== "string"))) throw new Error("题目选项标签无效");
  if (question.displayNumber !== undefined && (!Number.isInteger(question.displayNumber) || Number(question.displayNumber) <= 0)) throw new Error("题目编号无效");
  if (question.groupId !== undefined && !isSafeId(question.groupId)) throw new Error("题组 ID 无效");
  if (question.answerGroupId !== undefined && !isSafeId(question.answerGroupId)) throw new Error("共用答案组 ID 无效");
  if (question.groupTitle !== undefined && (typeof question.groupTitle !== "string" || question.groupTitle.length > 400)) throw new Error("题组标题无效");
  if (question.groupInstruction !== undefined && (typeof question.groupInstruction !== "string" || question.groupInstruction.length > 4000)) throw new Error("题组说明无效");
  if (question.groupContext !== undefined && (typeof question.groupContext !== "string" || question.groupContext.length > 4000)) throw new Error("题组上下文无效");
  if (question.answerLabel !== undefined && (typeof question.answerLabel !== "string" || question.answerLabel.length > 400)) throw new Error("答案标签无效");
  if (question.optionLabels && textRequiredTags.has(String((question.skillTags as string[])[0])) && Array.isArray(question.options)) {
    // 剥掉 "A. " 前缀后不能只剩字母本身，否则练习页只能渲染出 A、B、C、D。
    const labels = question.optionLabels as Record<string, string>;
    const bare = question.options.filter((option) => {
      const body = String(labels[option] ?? "").replace(/^[A-Z]\s*[.)]\s*/, "").trim();
      return body === "" || /^[A-Z]$/.test(body);
    });
    if (bare.length) throw new Error(`选项缺少列表正文：${bare.join(", ")}`);
  }
  if (question.acceptedAnswers !== undefined && (!Array.isArray(question.acceptedAnswers) || !question.acceptedAnswers.length || question.acceptedAnswers.some((answer) => typeof answer !== "string" || !answer.trim()))) throw new Error("可接受答案无效");
  if (question.answerGroupValues !== undefined && (!Array.isArray(question.answerGroupValues) || !question.answerGroupValues.length || question.answerGroupValues.some((answer) => typeof answer !== "string" || !answer.trim()))) throw new Error("组合答案无效");
}

export function assertActivity(value: unknown): asserts value is Activity {
  if (!value || typeof value !== "object") throw new Error("练习材料必须是对象");
  const activity = value as Record<string, unknown>;
  if (typeof activity.id !== "string" || !safeId.test(activity.id)) throw new Error("练习 ID 无效");
  if (typeof activity.pluginId !== "string" || !sectionIds.has(activity.pluginId as Section)) throw new Error("插件 ID 无效");
  if (typeof activity.title !== "string" || !activity.title.trim()) throw new Error("练习标题缺失");
  if (typeof activity.description !== "string") throw new Error("练习说明无效");
  if (activity.sourceName !== undefined && (typeof activity.sourceName !== "string" || activity.sourceName.length > 300)) throw new Error("练习来源无效");
  if (typeof activity.minutes !== "number" || !Number.isFinite(activity.minutes) || activity.minutes <= 0 || activity.minutes > 300) throw new Error("练习时长无效");
  if (typeof activity.difficulty !== "number" || ![1, 2, 3].includes(activity.difficulty)) throw new Error("练习难度无效");
  if (activity.part !== undefined) {
    const part = activity.part;
    if (typeof part !== "number" || ![1, 2, 3, 4].includes(part)) throw new Error("练习分段无效");
    if (activity.pluginId === "reading" && part > 3) throw new Error("阅读只有 Passage 1-3");
    if (activity.pluginId === "vocabulary") throw new Error("词汇练习没有 Part 或 Passage 分段");
  }
  if (typeof activity.sample !== "boolean") throw new Error("练习示例标记无效");
  if (activity.mockId !== undefined && !isSafeId(activity.mockId)) throw new Error("模考 ID 无效");
  if (activity.passage !== undefined && (!activity.passage || typeof activity.passage !== "object" || !isText((activity.passage as { title?: unknown }).title, 400) || typeof (activity.passage as { text?: unknown }).text !== "string" || !(activity.passage as { text: string }).text.trim())) throw new Error("阅读材料缺少文章标题或正文");
  if (activity.passages !== undefined) {
    if (!Array.isArray(activity.passages) || !activity.passages.length) throw new Error("文章列表无效");
    for (const passage of activity.passages) {
      if (!passage || typeof passage !== "object" || !isSafeId((passage as { id?: unknown }).id) || !isText((passage as { title?: unknown }).title, 400) || typeof (passage as { text?: unknown }).text !== "string" || !(passage as { text: string }).text.trim()) throw new Error("文章列表无效");
    }
  }
  if (activity.audioSections !== undefined) {
    if (!Array.isArray(activity.audioSections) || !activity.audioSections.length) throw new Error("音频分段无效");
    for (const section of activity.audioSections) {
      if (!section || typeof section !== "object" || !isText((section as { title?: unknown }).title, 400) || !audioPath((section as { audioUrl?: unknown }).audioUrl)) throw new Error("音频分段无效");
      if ((section as { transcript?: unknown }).transcript !== undefined && typeof (section as { transcript?: unknown }).transcript !== "string") throw new Error("音频分段文本无效");
    }
  }
  if (!Array.isArray(activity.questions) || !activity.questions.length) throw new Error("练习至少需要一道题");
  for (const question of activity.questions) assertQuestion(question);
  const questionIds = (activity.questions as Question[]).map((question) => question.id);
  if (new Set(questionIds).size !== questionIds.length) throw new Error("同一练习内题号不能重复");
  if ((activity.questions as Question[]).some((question) => question.skillTags.some((tag) => !tag.startsWith(String(activity.pluginId) + ".")))) throw new Error("能力标签必须使用插件 ID 命名空间");
  if (activity.pluginId === "reading" && !activity.passage && !activity.passages) throw new Error("阅读材料缺少文章标题或正文");
  if (activity.pluginId === "listening" && !audioPath(activity.audioUrl)) throw new Error("听力材料缺少音频引用");
  if (activity.pluginId === "listening" && (typeof activity.transcript !== "string" || !activity.transcript.trim())) throw new Error("听力材料缺少准确逐字文本");
}

