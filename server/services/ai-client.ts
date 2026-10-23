import { randomUUID } from "node:crypto";

export interface AiMessage { role: "system" | "user" | "assistant"; content: string }

export class AiClient {
  private readonly sessionId = process.env.IELTS_AI_SESSION_ID || randomUUID();

  missingSettings(): string[] {
    const missing: string[] = [];
    if (!process.env.IELTS_AI_BASE_URL) missing.push("IELTS_AI_BASE_URL");
    if (!process.env.IELTS_AI_MODEL) missing.push("IELTS_AI_MODEL");
    if (!process.env.IELTS_AI_API_KEY) missing.push("IELTS_AI_API_KEY");
    return missing;
  }

  async complete(messages: AiMessage[], options: { temperature?: number; maxTokens?: number; timeoutMs?: number; reasoningEffort?: "low" | "medium" | "high" } = {}): Promise<string> {
    const missing = this.missingSettings();
    if (missing.length) throw new Error(`AI 服务尚未配置，缺少 ${missing.join("、")}`);
    const base = process.env.IELTS_AI_BASE_URL!.replace(/\/+$/, "");
    const endpoint = base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
    const url = new URL(endpoint);
    if (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost") throw new Error("AI 服务地址需要使用 HTTPS");
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${process.env.IELTS_AI_API_KEY}`,
          "content-type": "application/json",
          "user-agent": "ielts-self-study-demo/0.1.0",
          "x-opencode-session": this.sessionId,
        },
        body: JSON.stringify({
          model: process.env.IELTS_AI_MODEL,
          temperature: options.temperature ?? 0.3,
          max_tokens: options.maxTokens ?? 700,
          ...(options.reasoningEffort ? { reasoning_effort: options.reasoningEffort } : {}),
          messages,
        }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "TimeoutError") throw new Error("AI 回复超时");
      throw new Error("连接 AI 服务失败");
    }
    if (!response.ok) {
      let detail = "";
      try {
        const payload: unknown = await response.json();
        if (payload && typeof payload === "object" && !Array.isArray(payload)) {
          const root = payload as Record<string, unknown>;
          const error = root.error;
          const message = typeof error === "string"
            ? error
            : error && typeof error === "object" && !Array.isArray(error)
              ? (error as Record<string, unknown>).message
              : root.message ?? root.detail;
          if (typeof message === "string") detail = message.trim().slice(0, 240);
        }
      } catch {
        // Some providers return a non-JSON error body; keep the status as the fallback.
      }
      throw new Error(`AI 服务返回 ${response.status}${detail ? `：${detail}` : ""}`);
    }
    const body: unknown = await response.json();
    if (!body || typeof body !== "object") throw new Error("AI 服务返回了无法识别的内容");
    const choices = (body as { choices?: Array<{ message?: { content?: unknown } }> }).choices;
    const content = choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) throw new Error("AI 服务没有返回文字回复");
    return content.trim().slice(0, 20_000);
  }
}
