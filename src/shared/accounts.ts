export interface Account {
  id: string;
  /** Login identifier persisted for the account: email or a legacy username. */
  username: string;
}

export interface AuthSession {
  account: Account | null;
}

export interface ModelUsage {
  category: "text" | "voice";
  model: string;
  responses: number;
  inputTokens: number;
  outputTokens: number;
  estimatedUsd: number | null;
  missingUsage: number;
  missingPrice: number;
}

export interface UsageSummary {
  models: ModelUsage[];
  voiceCallsWithoutUsage: number;
}
