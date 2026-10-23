import type { Activity, PluginManifest, Question, QuestionResult, Section } from "../../src/shared/domain.js";

export interface LearnerSnapshot {
  activity: Pick<Activity, "id" | "pluginId" | "title" | "description">;
  question: Pick<Question, "id" | "prompt" | "skillTags">;
  answer?: string;
  relatedEvidence: Array<{ skillTag: string; observed: number; total: number }>;
  relatedErrors: Array<{ questionId: string; prompt: string; explanation: string }>;
  task?: { title: string; reason: string };
  learner?: { targetListening: number; targetReading: number; examDate: string; dailyMinutes: number };
  mode: "practice" | "mock" | "review";
  pluginToolHint?: string;
  submittedResponse?: { correct: boolean; selected: string; correctAnswer: string; evidence: string; explanation: string };
}

export interface PluginHost {
  manifest: PluginManifest;
  registerActivity(activity: Activity): void;
  registerGrader(grader: (activity: Activity, answers: Record<string, string>, hints: string[]) => QuestionResult[]): void;
  registerCoachTool(name: string, description: string, handler: (snapshot: LearnerSnapshot, input?: string) => string): void;
  registerHintStrategy(strategy: (question: Question, activity: Activity) => string): void;
  registerSkillTags(tags: Record<string, string>): void;
}

export type PluginActivation = (host: PluginHost) => void | Promise<void>;
export type SectionId = Section;

