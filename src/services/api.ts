import type { SpeakingRecord, SpeakingSummary } from "../shared/speaking.js";
import { isBootstrapData, isProposalResponse } from "./response-validation.js";
import type { ActivityMode, AnswerDraft, AttemptResult, BootstrapData, CoachMessage, PlanTask, PublicActivity, Section } from "../shared/domain.js";

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly applied = false) {
    super(message);
    this.name = "ApiError";
  }
}

let onUnauthorized: (() => void) | undefined;
export function setUnauthorizedHandler(handler?: () => void): void { onUnauthorized = handler; }
let clockAnchor = { serverTime: Date.now(), monotonicTime: performance.now() };
function serverNow(): number { return clockAnchor.serverTime + performance.now() - clockAnchor.monotonicTime; }

const REQUEST_DEADLINE_MS = 30_000;
// The coach endpoint spends its own 30 秒 AI budget on top of snapshot and history reads,
// so the client deadline has to sit well beyond it or a slow-but-successful reply is
// aborted here while the server still commits it.
const COACH_DEADLINE_MS = 90_000;

// AbortSignal.any needs Safari 17.4+; build the same "deadline or caller cancel" signal
// with AbortController so older iOS WebViews keep working.
function requestDeadline(timeoutMs: number, external?: AbortSignal): { signal: AbortSignal; timedOut: () => boolean; dispose: () => void } {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const abort = () => controller.abort();
  if (external?.aborted) controller.abort();
  else external?.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => { clearTimeout(timer); external?.removeEventListener("abort", abort); },
  };
}

async function request<T>(path: string, init?: RequestInit, validate?: (body: unknown) => boolean, timeoutMs = REQUEST_DEADLINE_MS): Promise<T> {
  const deadline = requestDeadline(timeoutMs, init?.signal ?? undefined);
  try {
    let response: Response;
    try {
      response = await fetch(path, { ...init, headers: { ...(init?.body instanceof FormData ? {} : { "content-type": "application/json" }), ...init?.headers }, cache: "no-store", signal: deadline.signal });
    } catch (reason) {
      if (init?.signal?.aborted) throw reason;
      if (deadline.timedOut()) throw new Error("请求超时，操作结果尚未确认，请重新加载核对状态。");
      throw new Error("学习服务连接失败，请检查网络后重试；提交操作请重新加载核对状态。");
    }
    const serverTime = Number(response.headers.get("x-server-time"));
    if (serverTime > 0 && Number.isFinite(serverTime)) clockAnchor = { serverTime, monotonicTime: performance.now() };
    const body: unknown = await response.json().catch((reason: unknown) => {
      if (init?.signal?.aborted) throw reason;
      if (deadline.timedOut()) throw new Error("请求超时，操作结果尚未确认，请重新加载核对状态。");
      if (response.ok) throw new Error("学习服务返回的数据格式无效，请重新加载。");
      return {};
    });
    if (!response.ok) {
      const error = body && typeof body === "object" && "error" in body ? (body as { error: unknown }).error : "请求失败，请重试。";
      if (response.status === 401 && !path.startsWith("/api/auth/")) onUnauthorized?.();
      throw new ApiError(typeof error === "string" ? error : "请求失败，请重试。", response.status, Boolean(body && typeof body === "object" && "applied" in body && body.applied === true));
    }
    if (validate && !validate(body)) throw new Error("学习服务返回的数据格式无效，请重新加载。");
    return body as T;
  } finally {
    deadline.dispose();
  }
}

const bootstrapRequest = (path: string, init?: RequestInit) => request<BootstrapData>(path, init, isBootstrapData);

export const api = {
  serverNow,
  speakingHistory: () => request<{ sessions: SpeakingSummary[]; configurationError: string | null }>("/api/speaking/sessions"),
  speakingRecord: (id: string) => request<SpeakingRecord>("/api/speaking/sessions/" + encodeURIComponent(id)),
  saveSpeaking: (record: SpeakingRecord) => request<{ id: string }>("/api/speaking/sessions", { method: "POST", body: JSON.stringify(record) }),
  async speakingOffer(sdp: string, signal: AbortSignal): Promise<string> {
    const response = await fetch("/api/speaking/sdp", { method: "POST", headers: { "content-type": "application/sdp" }, body: sdp, signal });
    if (response.ok) return response.text();
    if (response.status === 401) onUnauthorized?.();
    const body = await response.json().catch(() => ({}));
    throw new ApiError(body.error ?? "实时通话连接失败，请重试。", response.status);
  },
  authSession: () => request<{ authenticated: boolean }>("/api/auth/session"),
  login: (password: string) => request<{ authenticated: boolean }>("/api/auth/login", { method: "POST", body: JSON.stringify({ password }) }),
  logout: () => request<{ authenticated: boolean }>("/api/auth/logout", { method: "POST", body: "{}" }),
  bootstrap: (signal?: AbortSignal) => bootstrapRequest("/api/bootstrap", { signal }),
  planProposalStatus: (signal?: AbortSignal) => request<{ proposal: BootstrapData["planProposal"] }>("/api/plan-proposals/status", { signal }, isProposalResponse),
  setProfile: (profile: Omit<BootstrapData["profile"], "id" | "updatedAt">) => bootstrapRequest("/api/profile", { method: "PUT", body: JSON.stringify(profile) }),
  retryPlanProposal: () => bootstrapRequest("/api/plan-proposals/retry", { method: "POST", body: "{}" }),
  confirmPlanProposal: (id: string) => bootstrapRequest("/api/plan-proposals/" + encodeURIComponent(id) + "/confirm", { method: "POST", body: "{}" }),
  dismissPlanProposal: (id: string) => bootstrapRequest("/api/plan-proposals/" + encodeURIComponent(id) + "/dismiss", { method: "POST", body: "{}" }),
  updatePlan: (id: string, update: { locked?: boolean; status?: "pending" | "done" }) => bootstrapRequest("/api/plans/" + encodeURIComponent(id), { method: "PATCH", body: JSON.stringify(update) }),
  startAttempt: (activityId: string, mode: ActivityMode, taskId?: string, reviewQuestionIds?: string[], questionIds?: string[]) =>
    request<{ draft: AnswerDraft; activity: PublicActivity; mode: ActivityMode }>("/api/attempts", { method: "POST", body: JSON.stringify({ activityId, mode, taskId, reviewQuestionIds, questionIds }) }),
  prepareMock: (section: "reading" | "listening") => request<{ activity: PublicActivity }>("/api/mock/prepare", { method: "POST", body: JSON.stringify({ section }) }),
  startMock: (section: "reading" | "listening", mockId: string, audioDurationsSeconds: number[] = []) =>
    request<{ draft: AnswerDraft; activity: PublicActivity; mode: "mock" }>("/api/mock/start", { method: "POST", body: JSON.stringify({ section, mockId, audioDurationsSeconds }) }),
  resumeAttempt: (attemptId: string) => request<{ draft?: AnswerDraft; result?: AttemptResult; activity?: PublicActivity }>("/api/attempts/" + encodeURIComponent(attemptId)),
  saveDraft: (attemptId: string, answers: Record<string, string>, questionTimeSeconds: Record<string, number> | undefined, revision: number, keepalive = false) => request<{ draft: AnswerDraft }>("/api/attempts/" + attemptId + "/draft", { method: "PATCH", body: JSON.stringify({ answers, questionTimeSeconds, revision }), keepalive }),
  submit: (attemptId: string, answers: Record<string, string>, questionTimeSeconds?: Record<string, number>) => request<{ result: AttemptResult }>("/api/attempts/" + attemptId + "/submit", { method: "POST", body: JSON.stringify({ answers, questionTimeSeconds }) }),
  confirmCause: (attemptId: string, questionId: string, skillTag: string, cause: string) => bootstrapRequest("/api/attempts/" + attemptId + "/cause", { method: "POST", body: JSON.stringify({ questionId, skillTag, cause }) }),
  askCoach: (conversationId: string, activityId: string, questionId: string, attemptId: string | undefined, message: string) => request<{ message: CoachMessage }>("/api/coach", { method: "POST", body: JSON.stringify({ conversationId, activityId, questionId, attemptId, message }) }, undefined, COACH_DEADLINE_MS),
  coachHistory: (conversationId: string) => request<{ messages: CoachMessage[] }>("/api/coach/history?conversationId=" + encodeURIComponent(conversationId)),
  mockMaterials: () => request<{ sets: BootstrapData["mockAvailability"] }>("/api/mock/available"),
  markInterrupted: (attemptId: string, reason: string) => {
    void fetch("/api/attempts/" + attemptId + "/interrupt", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason }), keepalive: true }).catch(() => undefined);
  },
  abandonAttempt: (attemptId: string) => request<{ ok: true }>("/api/attempts/" + encodeURIComponent(attemptId) + "/abandon", { method: "POST", body: "{}" }),
};

export type WorkspaceSection = Section;
