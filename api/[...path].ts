import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { Client } from "@neondatabase/serverless";
import { get } from "@vercel/blob";
import { waitUntil } from "@vercel/functions";
import { createApp } from "../server/index.js";
import { HttpError, errorResponse } from "../server/http-error.js";
import { PostgresLearningStore } from "../server/postgres-store.js";
import { PluginRegistry } from "../server/plugins/registry.js";
import type { Activity } from "../src/shared/domain.js";

const cookieName = "ielts_demo_session";
const sessionDays = 7;
let cachedCatalog: { expiresAt: number; activities: Activity[] } | undefined;
let schemaReady: Promise<void> | undefined;
type VercelRequest = IncomingMessage & { url?: string };
type VercelResponse = ServerResponse;
const secretIsSafe = (value: string | undefined): value is string => Boolean(value && value.length >= 32);
const passwordIsSafe = (value: string | undefined): value is string => Boolean(value && value.length >= 12);
function sign(payload: string, secret: string): string { return createHmac("sha256", secret).update(payload).digest("base64url"); }
function cookieValue(request: VercelRequest): string | undefined {
  return (request.headers.cookie ?? "").split(";").map((item) => item.trim()).find((item) => item.startsWith(cookieName + "="))?.slice(cookieName.length + 1);
}
function validSession(request: VercelRequest, secret: string): boolean {
  const value = cookieValue(request); if (!value) return false;
  const [expires, mac] = value.split("."); if (!expires || !mac || Number(expires) < Date.now()) return false;
  const expected = Buffer.from(sign(expires, secret)); const actual = Buffer.from(mac);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
function json(response: VercelResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8"); response.setHeader("Cache-Control", "no-store");
  for (const [name, content] of Object.entries(headers)) response.setHeader(name, content);
  response.end(JSON.stringify(value));
}

export default async function handler(request: VercelRequest, response: VercelResponse): Promise<void> {
  const password = process.env.IELTS_DEMO_PASSWORD;
  const secret = process.env.IELTS_SESSION_SECRET;
  const url = new URL(request.url ?? "/", `https://${request.headers.host ?? "localhost"}`);
  if (url.pathname === "/api/auth/session" && request.method === "GET") {
    if (!secretIsSafe(secret)) return json(response, 503, { error: "演示账号尚未完成安全配置。" });
    return json(response, 200, { authenticated: validSession(request, secret) });
  }
  if (url.pathname === "/api/auth/logout" && request.method === "POST") {
    return json(response, 200, { authenticated: false }, { "Set-Cookie": `${cookieName}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0` });
  }
  if (url.pathname === "/api/auth/login" && request.method === "POST") {
    if (!passwordIsSafe(password) || !secretIsSafe(secret)) return json(response, 503, { error: "演示账号尚未完成安全配置。" });
    let body = "";
    for await (const chunk of request) { body += chunk; if (body.length > 4096) return json(response, 413, { error: "登录请求过大。" }); }
    let submitted = "";
    try { submitted = String((JSON.parse(body || "{}") as { password?: unknown }).password ?? ""); } catch { return json(response, 400, { error: "登录请求格式无效。" }); }
    const forwarded = String(request.headers["x-forwarded-for"] ?? "unknown").split(",").map((part) => part.trim()).at(-1);
    const ipHash = createHash("sha256").update(forwarded ?? "unknown").digest("hex");
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) return json(response, 503, { error: "学习服务尚未完成配置。" });
    const client = new Client(dbUrl);
    try {
      await client.connect();
      await client.query("CREATE TABLE IF NOT EXISTS demo_login_attempts (source_hash TEXT PRIMARY KEY, failed_at TIMESTAMPTZ[] NOT NULL DEFAULT '{}')");
      await client.query("BEGIN");
      try {
        await client.query("INSERT INTO demo_login_attempts (source_hash, failed_at) VALUES ($1, '{}') ON CONFLICT (source_hash) DO NOTHING", [ipHash]);
        const record = await client.query("SELECT failed_at FROM demo_login_attempts WHERE source_hash=$1 FOR UPDATE", [ipHash]);
        const recent = ((record.rows[0]?.failed_at as Date[] | undefined) ?? []).filter((date) => Date.now() - new Date(date).getTime() < 15 * 60_000);
        if (recent.length >= 5) {
          await client.query("COMMIT");
          return json(response, 429, { error: "尝试次数较多，请 15 分钟后再试。" });
        }
        const submittedDigest = createHash("sha256").update(submitted).digest();
        const configuredDigest = createHash("sha256").update(password).digest();
        if (!timingSafeEqual(submittedDigest, configuredDigest)) {
          recent.push(new Date());
          await client.query("UPDATE demo_login_attempts SET failed_at=$2 WHERE source_hash=$1", [ipHash, recent]);
          await client.query("DELETE FROM demo_login_attempts WHERE source_hash<>$1 AND NOT EXISTS (SELECT 1 FROM unnest(failed_at) AS item WHERE item > NOW() - INTERVAL '15 minutes')", [ipHash]);
          await client.query("COMMIT");
          return json(response, 401, { error: "密码不正确，请再试一次。" });
        }
        await client.query("DELETE FROM demo_login_attempts WHERE source_hash=$1", [ipHash]);
        await client.query("COMMIT");
        const expires = String(Date.now() + sessionDays * 86_400_000);
        return json(response, 200, { authenticated: true }, { "Set-Cookie": `${cookieName}=${expires}.${sign(expires, secret)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${sessionDays * 86400}` });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    } catch { console.error("[auth] login service failed"); return json(response, 503, { error: "登录服务暂时不可用，请稍后重试。" }); }
    finally { await client.end().catch(() => undefined); }
  }
  if (url.pathname === "/api/health" && request.method === "GET") return json(response, 200, { ok: true });
  if (!secretIsSafe(secret) || !passwordIsSafe(password)) return json(response, 503, { error: "演示账号尚未完成安全配置。" });
  if (!validSession(request, secret)) return json(response, 401, { error: "请先登录再继续学习。" });
  if (!process.env.DATABASE_URL || !process.env.BLOB_READ_WRITE_TOKEN) return json(response, 503, { error: "学习服务尚未完成配置。" });

  const client = new Client(process.env.DATABASE_URL);
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    await client.connect();
    const store = new PostgresLearningStore(client);
    schemaReady ??= store.initialize().catch((error) => {
      schemaReady = undefined;
      throw error;
    });
    await schemaReady;
    const registry = new PluginRegistry(`${process.cwd()}/plugins`);
    await registry.loadAll();
    if (!cachedCatalog || cachedCatalog.expiresAt < Date.now()) cachedCatalog = { expiresAt: Date.now() + 5 * 60_000, activities: await store.importedActivities() };
    const catalog = cachedCatalog.activities;
    app = await createApp({
      production: true, store, registry, activities: catalog, cloudCatalog: true, waitUntil, deferStartupPlanning: true,
      mediaReader: async (pathname, range) => {
        const asset = await get(`media/${pathname}`, { access: "private", token: process.env.BLOB_READ_WRITE_TOKEN, ...(range ? { headers: { range } } : {}) });
        if (!asset || asset.statusCode !== 200) return undefined;
        const headers: Record<string, string> = {};
        for (const name of ["content-range", "accept-ranges", "etag"]) { const value = asset.headers.get(name); if (value) headers[name] = value; }
        return { stream: Readable.fromWeb(asset.stream as unknown as import("node:stream/web").ReadableStream<Uint8Array>), size: Number(asset.headers.get("content-length") ?? asset.blob.size), contentType: asset.blob.contentType, status: Number(asset.headers.get("content-range") ? 206 : 200), headers };
      },
    });
    await app.handle(request, response);
    waitUntil(app.close().finally(() => client.end()));
  } catch (error) {
    const failure = errorResponse(error);
    if (!(error instanceof HttpError)) console.error("[vercel-handler] request failed");
    if (response.headersSent) response.destroy(error instanceof Error ? error : undefined);
    else json(response, failure.status, failure.body);
    if (app) await app.close().catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}
