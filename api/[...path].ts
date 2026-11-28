import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { Client } from "@neondatabase/serverless";
import { get } from "@vercel/blob";
import { waitUntil } from "@vercel/functions";
import { AccountsStore } from "../server/accounts-store.js";
import { authenticate } from "../server/auth.js";
import { createApp } from "../server/index.js";
import { HttpError, errorResponse } from "../server/http-error.js";
import { sendJson } from "../server/http-json.js";
import { PostgresLearningStore } from "../server/postgres-store.js";
import { PluginRegistry } from "../server/plugins/registry.js";
import type { Activity } from "../src/shared/domain.js";

let cachedCatalog: { expiresAt: number; activities: Activity[] } | undefined;
let schemaReady: Promise<void> | undefined;

export default async function handler(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const path = new URL(request.url ?? "/", "https://localhost").pathname;
  if (path === "/api/health" && request.method === "GET") {
    sendJson(response, 200, { ok: true });
    return;
  }
  if (!process.env.DATABASE_URL) {
    sendJson(response, 503, { error: "学习服务尚未完成配置。" });
    return;
  }

  const client = new Client(process.env.DATABASE_URL);
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  let backgroundCleanup = false;
  try {
    await client.connect();
    const catalogStore = new PostgresLearningStore(client);
    schemaReady ??= catalogStore.initialize().catch((error) => {
      schemaReady = undefined;
      throw error;
    });
    await schemaReady;
    const accounts = new AccountsStore(async (sql, values) => (await client.query(sql, values)).rows);
    const account = await authenticate(request, response, path, accounts, true);
    if (!account) return;

    const registry = new PluginRegistry(`${process.cwd()}/plugins`);
    await registry.loadAll();
    if (!cachedCatalog || cachedCatalog.expiresAt < Date.now()) {
      cachedCatalog = { expiresAt: Date.now() + 5 * 60_000, activities: await catalogStore.importedActivities() };
    }
    app = await createApp({
      production: true, store: new PostgresLearningStore(client, account.id), registry,
      activities: cachedCatalog.activities, cloudCatalog: true, waitUntil, deferStartupPlanning: true,
      user: { account, accounts },
      mediaReader: async (pathname, range) => {
        const token = process.env.BLOB_READ_WRITE_TOKEN;
        if (!token) throw new HttpError("音频服务尚未完成配置。", 503);
        const asset = await get(`media/${pathname}`, { access: "private", token, ...(range ? { headers: { range } } : {}) });
        if (!asset || asset.statusCode !== 200) return undefined;
        const headers: Record<string, string> = {};
        for (const name of ["content-range", "accept-ranges", "etag"]) {
          const value = asset.headers.get(name);
          if (value) headers[name] = value;
        }
        return { stream: Readable.fromWeb(asset.stream as unknown as import("node:stream/web").ReadableStream<Uint8Array>), size: Number(asset.headers.get("content-length") ?? asset.blob.size), contentType: asset.blob.contentType, status: asset.headers.get("content-range") ? 206 : 200, headers };
      },
    });
    await app.handle(request, response);
    waitUntil(app.close().finally(() => client.end()).catch(() => console.error("[vercel-handler] request cleanup failed")));
    backgroundCleanup = true;
  } catch (error) {
    const failure = errorResponse(error);
    if (!(error instanceof HttpError)) console.error("[vercel-handler] request failed");
    if (response.headersSent) response.destroy(error instanceof Error ? error : undefined);
    else sendJson(response, failure.status, failure.body);
  } finally {
    if (!backgroundCleanup) {
      if (app) await app.close().catch(() => undefined);
      await client.end().catch(() => undefined);
    }
  }
}
