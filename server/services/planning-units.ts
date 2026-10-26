import { createHash } from "node:crypto";
import type { Activity, PlanTask, Question, QuestionKind, ReviewItem, Section, SkillEvidence } from "../../src/shared/domain.js";

export interface QuestionTimingSample {
  questionId: string;
  seconds: number;
  submittedAt: string;
}

export interface PlanningUnit {
  id: string;
  activityId: string;
  pluginId: "reading" | "listening";
  title: string;
  taskKind: PlanTask["kind"];
  questionKind: QuestionKind;
  questionIds: string[];
  dueReviewQuestionIds?: string[];
  focusSkillTag: string;
  skillTags: string[];
  questionCount: number;
  minutes: number;
  difficulty: Activity["difficulty"];
  novelty: "fresh" | "revisit" | "review";
  evidenceStatus: "insufficient" | "observed";
  recentIndependentCorrect?: number;
  recentIndependentSamples?: number;
  recentHinted?: number;
  confirmedCauseCount?: number;
}

interface AtomicGroup {
  questions: Question[];
  index: number;
}

function buildAtomicGroups(activity: Activity): AtomicGroup[] {
  const questions = activity.questions;
  const parent = questions.map((_, index) => index);
  const find = (index: number): number => {
    if (parent[index] !== index) parent[index] = find(parent[index]!);
    return parent[index]!;
  };
  const union = (left: number, right: number) => {
    const a = find(left); const b = find(right);
    if (a !== b) parent[b] = a;
  };
  const byGroup = new Map<string, number>();
  questions.forEach((question, index) => {
    for (const [namespace, value] of [["group", question.groupId], ["answer", question.answerGroupId]] as const) {
      if (!value) continue;
      const key = `${namespace}:${value}`;
      const previous = byGroup.get(key);
      if (previous === undefined) byGroup.set(key, index); else union(previous, index);
    }
  });
  const groups = new Map<number, AtomicGroup>();
  questions.forEach((question, index) => {
    const root = find(index);
    const group = groups.get(root) ?? { questions: [], index };
    group.questions.push(question);
    groups.set(root, group);
  });
  return [...groups.values()].sort((a, b) => a.index - b.index);
}

export function expandQuestionGroups(activity: Activity, questionIds: string[]): string[] {
  const ids = new Set(questionIds);
  if (ids.size !== questionIds.length || [...ids].some((id) => !activity.questions.some((question) => question.id === id))) {
    throw new Error("题目范围包含无效或重复的题目。");
  }
  return buildAtomicGroups(activity).flatMap((group) => {
    const selected = group.questions.some((question) => ids.has(question.id));
    if (selected && group.questions.some((question) => !ids.has(question.id))) throw new Error("所选题目拆分了关联题组，请一并选择整组题目。");
    return selected ? group.questions.map((question) => question.id) : [];
  });
}

export function completeQuestionGroups(activity: Activity, questionIds: string[]): string[] {
  const ids = new Set(questionIds);
  if (ids.size !== questionIds.length || [...ids].some((id) => !activity.questions.some((question) => question.id === id))) {
    throw new Error("题目范围包含无效或重复的题目。");
  }
  return buildAtomicGroups(activity).flatMap((group) => {
    return group.questions.some((question) => ids.has(question.id)) ? group.questions.map((question) => question.id) : [];
  });
}

function stableId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function median(values: number[]): number {
  const sorted = [...values].filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function estimatedMinutes(activity: Activity, questionById: Map<string, Question>, questionIds: string[], kind: QuestionKind, tag: string, timings: QuestionTimingSample[]): number {
  const samples = timings.filter((sample) => {
    const question = questionById.get(sample.questionId);
    return question?.kind === kind && question.skillTags.includes(tag);
  });
  // Until five observations exist for this candidate, scale the source material's expected duration.
  const reference = samples.length >= 5 ? median(samples.map((sample) => sample.seconds)) * questionIds.length / 60
    : activity.minutes * questionIds.length / Math.max(1, activity.questions.length);
  return Math.max(1, Math.ceil(reference));
}

function candidateGroups(groups: AtomicGroup[], attempted: Set<string>, reviews: Set<string>): Array<{ group: AtomicGroup; novelty: PlanningUnit["novelty"]; dueIds: string[] }> {
  return groups.flatMap<{ group: AtomicGroup; novelty: PlanningUnit["novelty"]; dueIds: string[] }>((group) => {
    const ids = group.questions.map((question) => question.id);
    const dueIds = ids.filter((id) => reviews.has(id));
    if (dueIds.length) return [{ group, novelty: "review" as const, dueIds }];
    return [{ group, novelty: ids.some((id) => attempted.has(id)) ? "revisit" as const : "fresh" as const, dueIds: [] }];
  });
}

export function buildPlanningUnits(input: {
  activities: Activity[];
  attemptedQuestionIds: string[];
  timingSamples: QuestionTimingSample[];
  evidence: SkillEvidence[];
  dueReviews: Array<Pick<ReviewItem, "questionId" | "activityId" | "pluginId">>;
  maxQuestions?: number;
}): PlanningUnit[] {
  const attempted = new Set(input.attemptedQuestionIds);
  // Built once: every planning unit needs the same question lookup.
  const questionById = new Map(input.activities.flatMap((activity) => activity.questions).map((question) => [question.id, question]));
  const dueByActivity = new Map<string, Set<string>>();
  for (const review of input.dueReviews) {
    const ids = dueByActivity.get(review.activityId) ?? new Set<string>();
    ids.add(review.questionId);
    dueByActivity.set(review.activityId, ids);
  }
  const evidence = new Map(input.evidence.map((item) => [`${item.pluginId}:${item.skillTag}`, item]));
  const units: PlanningUnit[] = [];
  const maxQuestions = Math.max(1, input.maxQuestions ?? 5);
  for (const activity of input.activities) {
    if (activity.pluginId !== "reading" && activity.pluginId !== "listening") continue;
    const groups = candidateGroups(buildAtomicGroups(activity), attempted, dueByActivity.get(activity.id) ?? new Set());
    const buckets = new Map<string, typeof groups>();
    for (const item of groups) {
      const kindSet = new Set(item.group.questions.map((question) => question.kind));
      const skillSet = new Set(item.group.questions.flatMap((question) => question.skillTags));
      for (const questionKind of kindSet) for (const skillTag of skillSet) {
        const key = `${item.novelty}:${questionKind}:${skillTag}`;
        buckets.set(key, [...(buckets.get(key) ?? []), item]);
      }
    }
    for (const [bucketKey, bucket] of buckets) {
      const [novelty, kindText, focusSkillTag] = bucketKey.split(":");
      const questionKind = kindText as QuestionKind;
      const groupedChunks: typeof bucket[] = [];
      let current: typeof bucket = [];
      let count = 0;
      for (const item of bucket) {
        const size = item.group.questions.length;
        if (current.length && count + size > maxQuestions) { groupedChunks.push(current); current = []; count = 0; }
        current.push(item); count += size;
      }
      if (current.length) groupedChunks.push(current);
      for (const chunk of groupedChunks) {
        const questionIds = chunk.flatMap((item) => item.group.questions.map((question) => question.id));
        const skillTags = [...new Set(chunk.flatMap((item) => item.group.questions.flatMap((question) => question.skillTags)))].sort();
        const dueReviewQuestionIds = [...new Set(chunk.flatMap((item) => item.dueIds))];
        const taskKind: PlanTask["kind"] = novelty === "review" ? "review" :
          (evidence.get(`${activity.pluginId}:${focusSkillTag}`)?.independentSamples ?? 0) < 3 && novelty === "fresh" ? "diagnostic" : "practice";
        const candidateKey = [activity.id, questionKind, focusSkillTag, novelty, questionIds.join(",")].join("|");
        const skillEvidence = evidence.get(`${activity.pluginId}:${focusSkillTag}`);
        units.push({
          id: `unit-${stableId(candidateKey)}`,
          activityId: activity.id,
          pluginId: activity.pluginId,
          title: activity.title,
          taskKind,
          questionKind,
          questionIds,
          ...(dueReviewQuestionIds.length ? { dueReviewQuestionIds } : {}),
          focusSkillTag,
          skillTags,
          questionCount: questionIds.length,
          minutes: estimatedMinutes(activity, questionById, questionIds, questionKind, focusSkillTag, input.timingSamples),
          difficulty: activity.difficulty,
          novelty: novelty as PlanningUnit["novelty"],
          evidenceStatus: (skillEvidence?.independentSamples ?? 0) < 3 ? "insufficient" : "observed",
          ...(skillEvidence ? {
            recentIndependentCorrect: skillEvidence.recentIndependentCorrect ?? 0,
            recentIndependentSamples: skillEvidence.recentIndependentSamples ?? 0,
            recentHinted: skillEvidence.recentHinted ?? 0,
            confirmedCauseCount: skillEvidence.recentCauseCount ?? 0,
          } : {}),
        });
      }
    }
  }
  return units.sort((a, b) => a.pluginId.localeCompare(b.pluginId) || a.title.localeCompare(b.title) || a.questionKind.localeCompare(b.questionKind) || a.focusSkillTag.localeCompare(b.focusSkillTag));
}

export function questionGroupsAreWhole(activity: Activity, questionIds: string[]): boolean {
  try { expandQuestionGroups(activity, questionIds); return true; } catch { return false; }
}

export function validateSelectedQuestionIds(activity: Activity, questionIds: string[]): string[] {
  return expandQuestionGroups(activity, questionIds);
}

export type PlanningSection = Extract<Section, "reading" | "listening">;
