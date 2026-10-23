import type { ActivityMode, AnswerDraft, AttemptResult, BootstrapData, CoachMessage, PlanTask, PublicActivity, Section } from "../shared/domain.js";

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

let onUnauthorized: (() => void) | undefined;
export function setUnauthorizedHandler(handler?: () => void): void { onUnauthorized = handler; }
let clockAnchor = { serverTime: Date.now(), monotonicTime: performance.now() };
function serverNow(): number { return clockAnchor.serverTime + performance.now() - clockAnchor.monotonicTime; }

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { ...init, headers: { ...(init?.body instanceof FormData ? {} : { "content-type": "application/json" }), ...init?.headers }, cache: "no-store" });
  } catch {
    throw new Error("学习服务连接失败，请检查网络后重试。");
  }
  const serverTime = Number(response.headers.get("x-server-time"));
  if (serverTime > 0 && Number.isFinite(serverTime)) clockAnchor = { serverTime, monotonicTime: performance.now() };
  const body: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = body && typeof body === "object" && "error" in body ? (body as { error: unknown }).error : "请求失败，请重试。";
    if (response.status === 401 && !path.startsWith("/api/auth/")) onUnauthorized?.();
    throw new ApiError(typeof error === "string" ? error : "请求失败，请重试。", response.status);
  }
  return body as T;
}

export const api = {
  serverNow,
  authSession: () => request<{ authenticated: boolean }>("/api/auth/session"),
  login: (password: string) => request<{ authenticated: boolean }>("/api/auth/login", { method: "POST", body: JSON.stringify({ password }) }),
  logout: () => request<{ authenticated: boolean }>("/api/auth/logout", { method: "POST", body: "{}" }),
  bootstrap: () => request<BootstrapData>("/api/bootstrap"),
  planProposalStatus: () => request<{ proposal: BootstrapData["planProposal"] }>("/api/plan-proposals/status"),
  setProfile: (profile: Omit<BootstrapData["profile"], "id" | "updatedAt">) => request<BootstrapData>("/api/profile", { method: "PUT", body: JSON.stringify(profile) }),
  retryPlanProposal: () => request<BootstrapData>("/api/plan-proposals/retry", { method: "POST", body: "{}" }),
  confirmPlanProposal: (id: string) => request<BootstrapData>("/api/plan-proposals/" + encodeURIComponent(id) + "/confirm", { method: "POST", body: "{}" }),
  dismissPlanProposal: (id: string) => request<BootstrapData>("/api/plan-proposals/" + encodeURIComponent(id) + "/dismiss", { method: "POST", body: "{}" }),
  updatePlan: (id: string, update: { locked?: boolean; status?: "pending" | "done" }) => request<BootstrapData>("/api/plans/" + encodeURIComponent(id), { method: "PATCH", body: JSON.stringify(update) }),
  startAttempt: (activityId: string, mode: ActivityMode, taskId?: string, reviewQuestionIds?: string[], questionIds?: string[]) =>
    request<{ draft: AnswerDraft; activity: PublicActivity; mode: ActivityMode }>("/api/attempts", { method: "POST", body: JSON.stringify({ activityId, mode, taskId, reviewQuestionIds, questionIds }) }),
  prepareMock: (section: "reading" | "listening") => request<{ activity: PublicActivity }>("/api/mock/prepare", { method: "POST", body: JSON.stringify({ section }) }),
  startMock: (section: "reading" | "listening", mockId: string, audioDurationsSeconds: number[] = []) =>
    request<{ draft: AnswerDraft; activity: PublicActivity; mode: "mock" }>("/api/mock/start", { method: "POST", body: JSON.stringify({ section, mockId, audioDurationsSeconds }) }),
  resumeAttempt: (attemptId: string) => request<{ draft?: AnswerDraft; result?: AttemptResult; activity?: PublicActivity }>("/api/attempts/" + encodeURIComponent(attemptId)),
  saveDraft: (attemptId: string, answers: Record<string, string>, questionTimeSeconds: Record<string, number> | undefined, revision: number, keepalive = false) => request<{ draft: AnswerDraft }>("/api/attempts/" + attemptId + "/draft", { method: "PATCH", body: JSON.stringify({ answers, questionTimeSeconds, revision }), keepalive }),
  submit: (attemptId: string, answers: Record<string, string>, questionTimeSeconds?: Record<string, number>) => request<{ result: AttemptResult }>("/api/attempts/" + attemptId + "/submit", { method: "POST", body: JSON.stringify({ answers, questionTimeSeconds }) }),
  confirmCause: (attemptId: string, questionId: string, skillTag: string, cause: string) => request<BootstrapData>("/api/attempts/" + attemptId + "/cause", { method: "POST", body: JSON.stringify({ questionId, skillTag, cause }) }),
  askCoach: (conversationId: string, activityId: string, questionId: string, attemptId: string | undefined, message: string) => request<{ message: CoachMessage }>("/api/coach", { method: "POST", body: JSON.stringify({ conversationId, activityId, questionId, attemptId, message }) }),
  coachHistory: (conversationId: string) => request<{ messages: CoachMessage[] }>("/api/coach/history?conversationId=" + encodeURIComponent(conversationId)),
  mockMaterials: () => request<{ sets: BootstrapData["mockAvailability"] }>("/api/mock/available"),
  markInterrupted: (attemptId: string, reason: string) => {
    void fetch("/api/attempts/" + attemptId + "/interrupt", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason }), keepalive: true }).catch(() => undefined);
  },
  abandonAttempt: (attemptId: string) => request<{ ok: true }>("/api/attempts/" + encodeURIComponent(attemptId) + "/abandon", { method: "POST", body: "{}" }),
};

export type WorkspaceSection = Section;
