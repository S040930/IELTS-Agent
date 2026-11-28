import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { Account, ModelUsage, UsageSummary } from "../src/shared/accounts.js";

type Row = Record<string, unknown>;
export type Query = (sql: string, values?: SQLInputValue[]) => Promise<Row[]>;
export const sqliteQuery = (db: DatabaseSync): Query => async (sql, values = []) => {
  const bindings = Object.fromEntries(values.map((value, index) => ["$" + (index + 1), value]));
  const statement = db.prepare(sql);
  return values.length ? statement.all(bindings) : statement.all();
};

export async function initializeAccounts(query: Query): Promise<void> {
  for (const sql of [
    `CREATE TABLE IF NOT EXISTS ielts_accounts (
      id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS ielts_sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES ielts_accounts(id), expires_at BIGINT NOT NULL
    )`,
    "CREATE INDEX IF NOT EXISTS ielts_sessions_expiry ON ielts_sessions(expires_at)",
    `CREATE TABLE IF NOT EXISTS ielts_auth_limits (
      scope TEXT NOT NULL, time_slot BIGINT NOT NULL, requests INTEGER NOT NULL, PRIMARY KEY(scope, time_slot)
    )`,
    "CREATE INDEX IF NOT EXISTS ielts_auth_limits_slot ON ielts_auth_limits(time_slot)",
    `CREATE TABLE IF NOT EXISTS ielts_voice_calls (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES ielts_accounts(id), model TEXT NOT NULL,
      region TEXT NOT NULL, created_at BIGINT NOT NULL
    )`,
    "CREATE INDEX IF NOT EXISTS ielts_voice_calls_user ON ielts_voice_calls(user_id)",
    `CREATE TABLE IF NOT EXISTS ielts_usage_events (
      user_id TEXT NOT NULL REFERENCES ielts_accounts(id), event_id TEXT NOT NULL, category TEXT NOT NULL,
      model TEXT NOT NULL, input_tokens INTEGER, output_tokens INTEGER, cost_usd DOUBLE PRECISION,
      call_id TEXT REFERENCES ielts_voice_calls(id), PRIMARY KEY(user_id, event_id)
    )`,
    "CREATE INDEX IF NOT EXISTS ielts_usage_events_call ON ielts_usage_events(call_id)",
  ]) await query(sql);
}

export class AccountsStore {
  constructor(private readonly query: Query) {}

  async createAccount(account: Account, passwordHash: string): Promise<boolean> {
    return (await this.query(`INSERT INTO ielts_accounts (id, username, password_hash) VALUES ($1,$2,$3)
      ON CONFLICT (username) DO NOTHING RETURNING id`, [account.id, account.username, passwordHash])).length === 1;
  }

  async findAccount(username: string): Promise<(Account & { passwordHash: string }) | undefined> {
    const [row] = await this.query("SELECT id, username, password_hash FROM ielts_accounts WHERE username=$1", [username]);
    return row && { id: String(row.id), username: String(row.username), passwordHash: String(row.password_hash) };
  }

  async startSession(tokenHash: string, userId: string, expiresAt: number): Promise<void> {
    await this.query("DELETE FROM ielts_sessions WHERE expires_at <= $1", [Date.now()]);
    await this.query("INSERT INTO ielts_sessions (token_hash, user_id, expires_at) VALUES ($1,$2,$3)", [tokenHash, userId, expiresAt]);
  }

  async session(tokenHash: string): Promise<Account | null> {
    const [row] = await this.query(`SELECT a.id, a.username FROM ielts_sessions s JOIN ielts_accounts a ON a.id=s.user_id
      WHERE s.token_hash=$1 AND s.expires_at > $2`, [tokenHash, Date.now()]);
    return row ? { id: String(row.id), username: String(row.username) } : null;
  }

  async endSession(tokenHash: string): Promise<void> {
    await this.query("DELETE FROM ielts_sessions WHERE token_hash=$1", [tokenHash]);
  }

  async allowAuthRequest(scope: string, limit: number): Promise<boolean> {
    const slot = Math.floor(Date.now() / (15 * 60_000));
    await this.query("DELETE FROM ielts_auth_limits WHERE time_slot < $1", [slot - 1]);
    return (await this.query(`INSERT INTO ielts_auth_limits (scope, time_slot, requests) VALUES ($1,$2,1)
      ON CONFLICT (scope, time_slot) DO UPDATE SET requests=ielts_auth_limits.requests+1
      WHERE ielts_auth_limits.requests < $3 RETURNING requests`, [scope, slot, limit])).length === 1;
  }

  async openVoiceCall(userId: string, id: string, model: string, region: string): Promise<void> {
    await this.query(`INSERT INTO ielts_voice_calls (id, user_id, model, region, created_at) VALUES ($1,$2,$3,$4,$5)`,
      [id, userId, model, region, Date.now()]);
  }

  async voiceCall(userId: string, id: string): Promise<{ model: string; region: string } | undefined> {
    const [row] = await this.query("SELECT model, region FROM ielts_voice_calls WHERE id=$1 AND user_id=$2 AND created_at > $3",
      [id, userId, Date.now() - 86_400_000]);
    return row && { model: String(row.model), region: String(row.region) };
  }

  async recordUsage(userId: string, eventId: string, category: ModelUsage["category"], model: string,
    input: number | null, output: number | null, costUsd: number | null, callId: string | null = null): Promise<void> {
    await this.query(`INSERT INTO ielts_usage_events (user_id, event_id, category, model, input_tokens, output_tokens, cost_usd, call_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (user_id, event_id) DO NOTHING`,
    [userId, eventId, category, model, input, output, costUsd, callId]);
  }

  async usage(userId: string): Promise<UsageSummary> {
    const groups = await this.query(`SELECT category, model, COUNT(*) AS responses,
      SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens, SUM(cost_usd) AS estimated_usd,
      COUNT(*) - COUNT(input_tokens) AS missing_usage, COUNT(input_tokens) - COUNT(cost_usd) AS missing_price
      FROM ielts_usage_events WHERE user_id=$1 GROUP BY category, model ORDER BY category, model`, [userId]);
    const [calls] = await this.query(`SELECT COUNT(*) AS missing FROM ielts_voice_calls c WHERE c.user_id=$1 AND NOT EXISTS (
      SELECT 1 FROM ielts_usage_events e WHERE e.call_id=c.id AND e.user_id=c.user_id AND e.input_tokens IS NOT NULL)`, [userId]);
    return {
      models: groups.map((row) => ({
        category: row.category as ModelUsage["category"], model: String(row.model), responses: Number(row.responses),
        inputTokens: Number(row.input_tokens ?? 0), outputTokens: Number(row.output_tokens ?? 0),
        estimatedUsd: row.estimated_usd === null ? null : Number(row.estimated_usd),
        missingUsage: Number(row.missing_usage), missingPrice: Number(row.missing_price),
      })),
      voiceCallsWithoutUsage: Number(calls?.missing ?? 0),
    };
  }
}
