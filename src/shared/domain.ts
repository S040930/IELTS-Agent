export type Section = "listening" | "reading" | "vocabulary";
export type ActivityMode = "practice" | "mock" | "review";
export type QuestionKind = "choice" | "tfng" | "completion";

export interface Question {
  id: string;
  prompt: string;
  kind: QuestionKind;
  options?: string[];
  optionLabels?: Record<string, string>;
  displayNumber?: number;
  groupId?: string;
  groupTitle?: string;
  groupInstruction?: string;
  groupContext?: string;
  answerLabel?: string;
  acceptedAnswers?: string[];
  answerGroupId?: string;
  answerGroupValues?: string[];
  skillTags: string[];
  correctAnswer: string;
  evidence: string;
  explanation: string;
}

export interface Activity {
  id: string;
  pluginId: Section;
  title: string;
  description: string;
  sourceName?: string;
  minutes: number;
  difficulty: 1 | 2 | 3;
  /** 真实考试分段：listening 为 Part 1-4，reading 为 Passage 1-3。缺省表示未标注。 */
  part?: 1 | 2 | 3 | 4;
  mockId?: string;
  examParts?: ExamPart[];
  passage?: { title: string; text: string };
  passages?: Array<{ id: string; title: string; text: string }>;
  audioUrl?: string;
  audioSections?: Array<{ title: string; audioUrl: string; transcript?: string }>;
  transcript?: string;
  questions: Question[];
  sample: boolean;
}

export interface PublicActivity extends Omit<Activity, "questions" | "transcript" | "audioSections"> {
  questions: Omit<Question, "correctAnswer" | "answerLabel" | "acceptedAnswers" | "answerGroupValues" | "evidence" | "explanation">[];
  audioSections?: Array<Omit<NonNullable<Activity["audioSections"]>[number], "transcript">>;
  transcript?: never;
}

export interface ExamPart {
  part: number;
  sourceActivityId: string;
  questionIds: string[];
  passageId?: string;
  audioSectionIndex?: number;
}

export interface ExamTiming {
  durationSeconds: number;
  audioDurationsSeconds: number[];
}

export function examDeadline(startedAt: string, timing: ExamTiming): string {
  return new Date(Date.parse(startedAt) + timing.durationSeconds * 1000).toISOString();
}

export interface LearnerProfile {
  id: string;
  targetListening: number;
  targetReading: number;
  examDate: string;
  dailyMinutes: number;
  updatedAt: string;
  setupComplete: boolean;
}

export interface ReviewItem {
  questionId: string;
  activityId: string;
  pluginId: Section;
  prompt: string;
  dueDate: string;
  lastResult: string;
  streak: number;
}

export interface AnswerDraft {
  attemptId: string;
  activityId: string;
  taskId?: string;
  questionIds?: string[];
  reviewQuestionIds?: string[];
  mode: ActivityMode;
  answers: Record<string, string>;
  questionTimeSeconds?: Record<string, number>;
  saveRevision?: number;
  hintedQuestionIds: string[];
  startedAt: string;
  updatedAt: string;
  interruption?: string;
  examTiming?: ExamTiming;
  deadlineAt?: string;
}

export interface AttemptResult extends AnswerDraft {
  pluginId: Section;
  submittedAt: string;
  score: number;
  total: number;
  responses: QuestionResult[];
  sample: boolean;
}

export interface QuestionResult {
  questionId: string;
  correct: boolean;
  independent: boolean;
  selected: string;
  correctAnswer: string;
  evidence: string;
  explanation: string;
  skillTags: string[];
  materialId: string;
}

export interface SkillEvidence {
  pluginId: Section;
  skillTag: string;
  observed: number;
  independent: number;
  total: number;
  hinted: number;
  lastSeen: string;
  confidence: "emerging" | "developing" | "established";
  userConfirmedCause?: string;
  recentTotal?: number;
  recentCorrect?: number;
  recentIndependentCorrect?: number;
  recentIndependentSamples?: number;
  recentHinted?: number;
  recentCauseCount?: number;
  independentSamples?: number;
  evidenceStatus?: "insufficient" | "observed";
  recentMedianSeconds?: number;
  lifetimeMedianSeconds?: number;
}

export interface PlanTask {
  id: string;
  date: string;
  activityId: string;
  pluginId: Section;
  kind: "review" | "practice" | "diagnostic";
  title: string;
  description: string;
  minutes: number;
  reason: string;
  questionIds?: string[];
  focusSkillTag?: string;
  questionKind?: QuestionKind;
  reviewQuestionIds?: string[];
  locked: boolean;
  status: "pending" | "done" | "expired";
}

export interface PlanProposalChange {
  kind: "added" | "removed" | "updated";
  before?: PlanTask;
  after?: PlanTask;
}

export interface PlanProposal {
  id?: string;
  planDate?: string;
  status: "idle" | "generating" | "ready" | "failed" | "dismissed" | "confirmed";
  tasks?: PlanTask[];
  changes: PlanProposalChange[];
  error?: string;
  updatedAt?: string;
  recoverable?: boolean;
}

export interface CoachMessage {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  sdkVersion: number;
  section: Section;
  serverEntry: string;
  browserEntry: string;
  capabilities: string[];
  dependencies?: Record<string, string>;
}

export interface BrowserPlugin {
  id: string;
  section: Section;
  browserUrl: string;
}

export interface MockAvailability {
  section: "listening" | "reading";
  mockId?: string;
  title?: string;
  ready: boolean;
  questions: number;
  expected: number;
  message: string;
}

export interface BootstrapData {
  profile: LearnerProfile;
  activities: PublicActivity[];
  plugins: BrowserPlugin[];
  plan: PlanTask[];
  planProposal: PlanProposal;
  evidence: SkillEvidence[];
  attempts: AttemptResult[];
  dueReviews: number;
  mockAvailability: MockAvailability[];
  aiConfigured: boolean;
  skillLabels: Record<string, string>;
  reviewQueue: ReviewItem[];
}

