import { randomInt, randomUUID } from "node:crypto";
import type { Activity, ExamTiming, MockAvailability, Section } from "../../src/shared/domain.js";

const paperInstructions = /(?:ten|10)\s+minutes?[\s\S]{0,120}(?:transfer|answer\s*sheet)|transfer[\s\S]{0,80}(?:ten|10)\s+minutes?/i;

function candidates(section: "reading" | "listening", activities: Activity[]): Activity[][] {
  return Array.from({ length: section === "reading" ? 3 : 4 }, (_, index) => activities.filter((activity) =>
    activity.pluginId === section && activity.part === index + 1 && !activity.sample
    && (section === "reading"
      ? Boolean(activity.passage?.text && activity.questions.length > 0 && activity.questions.length < 40)
      : Boolean(activity.audioUrl && activity.transcript && activity.questions.length === 10 && !paperInstructions.test(activity.transcript))),
  ));
}

function readingCounts(pools: Activity[][]): number[][] {
  const counts = pools.map((pool) => [...new Set(pool.map((activity) => activity.questions.length))]);
  const combinations: number[][] = [];
  for (const first of counts[0] ?? []) for (const second of counts[1] ?? []) {
    const third = 40 - first - second;
    if (counts[2]?.includes(third)) combinations.push([first, second, third]);
  }
  return combinations;
}

export function listCompleteMocks(activities: Activity[]): MockAvailability[] {
  return (["listening", "reading"] as const).map((section) => {
    const pools = candidates(section, activities);
    const ready = pools.every((pool) => pool.length > 0) && (section === "listening" || readingCounts(pools).length > 0);
    const missing = pools.flatMap((pool, index) => pool.length ? [] : [`${section === "reading" ? "Passage" : "Part"} ${index + 1}`]);
    return {
      section, title: "组合模拟卷", ready, questions: ready ? 40 : 0, expected: 40,
      message: ready
        ? `${section === "reading" ? "3 篇文章 · 60 分钟" : "4 段录音 · 单次播放 · 2 分钟检查"}，从现有题库组合 40 题。`
        : missing.length ? `缺少可用于机考的完整材料：${missing.join("、")}。` : "现有阅读材料无法组合为 40 题。",
    };
  });
}

export function composeMock(section: "listening" | "reading", mockId: string, activities: Activity[]): Activity | undefined {
  const pools = candidates(section, activities);
  if (pools.some((pool) => !pool.length)) return undefined;
  let selectedPools = pools;
  if (section === "reading") {
    const combinations = readingCounts(pools);
    if (!combinations.length) return undefined;
    const sizes = combinations[randomInt(combinations.length)]!;
    selectedPools = pools.map((pool, index) => pool.filter((activity) => activity.questions.length === sizes[index]));
  }
  const parts = selectedPools.map((pool) => pool[randomInt(pool.length)]!);
  if (new Set(parts.flatMap((part) => part.questions.map((question) => question.id))).size !== 40) return undefined;
  let number = 0;
  return {
    id: `fullmock:${section}:${mockId}`, pluginId: section, mockId,
    title: `${section === "reading" ? "学术阅读" : "听力"} · 组合模拟卷`,
    description: "由现有分段材料组合，非原版成套试卷。", minutes: section === "reading" ? 60 : 32,
    difficulty: 3, sample: false,
    questions: parts.flatMap((part) => [...part.questions].sort((a, b) => (a.displayNumber ?? 0) - (b.displayNumber ?? 0)).map((question) => ({ ...question, displayNumber: ++number }))),
    examParts: parts.map((part, index) => ({
      part: index + 1, sourceActivityId: part.id, questionIds: part.questions.map((question) => question.id),
      ...(section === "reading" ? { passageId: `passage-${index + 1}` } : { audioSectionIndex: index }),
    })),
    ...(section === "reading"
      ? { passages: parts.map((part, index) => ({ id: `passage-${index + 1}`, ...part.passage! })) }
      : { audioSections: parts.map((part, index) => ({ title: `Part ${index + 1}`, audioUrl: part.audioUrl!, transcript: part.transcript })) }),
  };
}

export function mockTiming(activity: Activity, durations: unknown): ExamTiming {
  if (activity.pluginId === "reading") return { durationSeconds: 3600, audioDurationsSeconds: [] };
  if (!Array.isArray(durations) || durations.length !== 4 || durations.some((value) => typeof value !== "number" || !Number.isFinite(value) || value < 1 || value > 1800)) {
    throw new Error("请先完成四段录音的音频预检。");
  }
  return { durationSeconds: durations.reduce((sum: number, value: number) => sum + value, 120), audioDurationsSeconds: durations };
}

export function mockDraftPluginId(activityId: string): Section | undefined {
  const [, section] = activityId.split(":");
  return section === "reading" || section === "listening" ? section : undefined;
}
export function isMockActivityId(activityId: string): boolean { return activityId.startsWith("fullmock:"); }
export function makeAttemptId(): string { return randomUUID(); }
