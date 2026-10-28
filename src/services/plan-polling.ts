import type { PlanProposal } from "../shared/domain.js";

export function startPlanPolling(options: {
  proposalId?: string;
  read: (signal: AbortSignal) => Promise<{ proposal: PlanProposal }>;
  settled: (signal: AbortSignal) => Promise<unknown>;
  error: (reason: unknown) => void;
  delayMs?: number;
}): () => void {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const schedule = () => { timer = setTimeout(() => void poll(), options.delayMs ?? 2500); };
  const poll = async () => {
    try {
      const { proposal } = await options.read(controller.signal);
      if (controller.signal.aborted) return;
      if (proposal.id !== options.proposalId || proposal.status !== "generating" || proposal.recoverable) {
        await options.settled(controller.signal);
        return;
      }
    } catch (reason) {
      if (controller.signal.aborted) return;
      options.error(reason);
    }
    if (!controller.signal.aborted) schedule();
  };
  schedule();
  return () => { controller.abort(); clearTimeout(timer); };
}
