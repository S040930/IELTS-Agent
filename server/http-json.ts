import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError } from "./http-error.js";

export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "x-server-time": String(Date.now()) });
  res.end(JSON.stringify(payload));
}

export async function readJson(req: IncomingMessage, maxBytes = 1_500_000): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const data of req) {
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
    size += chunk.byteLength;
    if (size > maxBytes) throw new HttpError("提交的内容过大，请缩小文件后重试。", 413);
    chunks.push(chunk);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch { throw new HttpError("请求内容不是有效 JSON。"); }
}
