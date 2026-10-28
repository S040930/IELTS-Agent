import type { PlanningInput } from "./ai-planner.js";
import type { PlanTask } from "../../src/shared/domain.js";

// Deliberately omit free text from causes, historical tasks and catalog titles.
// New task titles are restored from the trusted unit after model selection.
export function planningPayload(input: PlanningInput) {
  const task = (item: PlanTask) => ({
    date: item.date, activityId: item.activityId, pluginId: item.pluginId, kind: item.kind,
    questionIds: item.questionIds, minutes: item.minutes, locked: item.locked, status: item.status,
    focusSkillTag: item.focusSkillTag, questionKind: item.questionKind,
  });
  return {
    today: input.today,
    profile: {
      targetListening: input.profile.targetListening, targetReading: input.profile.targetReading,
      examDate: input.profile.examDate, dailyMinutes: input.profile.dailyMinutes,
    },
    evidence: input.evidence.map((item) => ({
      pluginId: item.pluginId, skillTag: item.skillTag, observed: item.observed, independent: item.independent,
      total: item.total, hinted: item.hinted, confidence: item.confidence, independentSamples: item.independentSamples,
      recentTotal: item.recentTotal, recentCorrect: item.recentCorrect,
      recentIndependentCorrect: item.recentIndependentCorrect, recentIndependentSamples: item.recentIndependentSamples,
      recentHinted: item.recentHinted, recentCauseCount: item.recentCauseCount,
      recentMedianSeconds: item.recentMedianSeconds, lifetimeMedianSeconds: item.lifetimeMedianSeconds,
      evidenceStatus: item.evidenceStatus,
    })),
    units: input.units.map((unit) => ({
      id: unit.id, activityId: unit.activityId, pluginId: unit.pluginId, taskKind: unit.taskKind,
      questionKind: unit.questionKind, questionIds: unit.questionIds, dueReviewQuestionIds: unit.dueReviewQuestionIds,
      focusSkillTag: unit.focusSkillTag, skillTags: unit.skillTags, questionCount: unit.questionCount,
      minutes: unit.minutes, difficulty: unit.difficulty, novelty: unit.novelty, evidenceStatus: unit.evidenceStatus,
      recentIndependentCorrect: unit.recentIndependentCorrect, recentIndependentSamples: unit.recentIndependentSamples,
      recentHinted: unit.recentHinted, confirmedCauseCount: unit.confirmedCauseCount,
    })),
    currentTasks: input.currentTasks.map(task), fixedTasks: input.fixedTasks.map(task),
    overdueTasks: input.overdueTasks.map(task), requiredBaselineSections: input.requiredBaselineSections,
  };
}
