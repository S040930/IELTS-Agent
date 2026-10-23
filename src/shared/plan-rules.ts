import type { PlanTask } from "./domain.js";

export function planReplacementError(tasks: PlanTask[], fixed: PlanTask[], dailyMinutes: number, day: string): string | undefined {
  if (!Array.isArray(tasks) || !tasks.length) return "方案没有可执行的任务，请重新规划。";
  if (tasks.some((task) => task.date !== day)) return "方案日期已失效，请重新规划。";
  if (tasks.reduce((sum, task) => sum + task.minutes, 0) + fixed.reduce((sum, task) => sum + task.minutes, 0) > dailyMinutes) {
    return "方案超出了当前每日学习时间，请重新规划。";
  }
  const questions = new Set(fixed.flatMap((task) => (task.questionIds ?? []).map((id) => task.activityId + ":" + id)));
  for (const task of tasks) for (const id of task.questionIds ?? []) {
    const key = task.activityId + ":" + id;
    if (questions.has(key)) return "方案与保留任务重复安排了题目，请重新规划。";
    questions.add(key);
  }
  return undefined;
}
