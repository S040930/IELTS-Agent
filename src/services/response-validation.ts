import type { BootstrapData, PlanProposal } from "../shared/domain.js";

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function task(value: unknown): boolean {
  return record(value) && ["id", "date", "activityId", "pluginId", "title", "description", "reason"].every((key) => typeof value[key] === "string")
    && ["diagnostic", "practice", "review"].includes(String(value.kind))
    && ["pending", "done", "expired"].includes(String(value.status))
    && typeof value.locked === "boolean" && typeof value.minutes === "number" && Number.isFinite(value.minutes) && value.minutes > 0
    && (value.questionIds === undefined || (Array.isArray(value.questionIds) && value.questionIds.every((id) => typeof id === "string")));
}
export function isPlanProposal(value: unknown): value is PlanProposal {
  return record(value) && ["idle", "generating", "ready", "failed", "dismissed", "confirmed"].includes(String(value.status))
    && Array.isArray(value.changes) && value.changes.every((change) => record(change)
      && ["added", "removed", "updated"].includes(String(change.kind))
      && (change.before === undefined || task(change.before)) && (change.after === undefined || task(change.after)))
    && (value.tasks === undefined || (Array.isArray(value.tasks) && value.tasks.every(task)))
    && (value.status !== "ready" || (typeof value.id === "string" && Array.isArray(value.tasks)))
    && (value.id === undefined || typeof value.id === "string")
    && (value.updatedAt === undefined || typeof value.updatedAt === "string")
    && (value.recoverable === undefined || typeof value.recoverable === "boolean");
}
export function isBootstrapData(value: unknown): value is BootstrapData {
  if (!record(value) || !record(value.profile) || !isPlanProposal(value.planProposal)) return false;
  const profile = value.profile;
  return typeof profile.id === "string" && typeof profile.updatedAt === "string" && typeof profile.examDate === "string"
    && typeof profile.setupComplete === "boolean"
    && [profile.targetListening, profile.targetReading, profile.dailyMinutes].every((item) => typeof item === "number" && Number.isFinite(item))
    && ["activities", "plugins", "plan", "evidence", "attempts", "mockAvailability", "reviewQueue"].every((key) => Array.isArray(value[key]))
    && (value.plan as unknown[]).every(task)
    && record(value.skillLabels) && typeof value.aiConfigured === "boolean" && typeof value.dueReviews === "number";
}
export function isProposalResponse(value: unknown): value is { proposal: PlanProposal } {
  return record(value) && isPlanProposal(value.proposal);
}
