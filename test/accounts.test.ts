import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createLocalApp } from "../server/local-app.js";
import type { Account, UsageSummary } from "../src/shared/accounts.js";

test("local accounts isolate learning history and attribute text and voice usage once", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ielts-accounts-"));
  const originalEnv = { ...process.env };
  const offer = "v=0\r\nm=audio 9 RTP/AVP 0\r\n";
  Object.assign(process.env, {
    IELTS_AI_BASE_URL: "https://text.example.test/v1", IELTS_AI_MODEL: "test-text", IELTS_AI_API_KEY: "test",
    IELTS_AI_INPUT_USD_PER_MILLION: "2", IELTS_AI_OUTPUT_USD_PER_MILLION: "4", IELTS_AI_CACHED_INPUT_USD_PER_MILLION: "1",
    IELTS_REALTIME_HOST: "workspace.cn-beijing.maas.aliyuncs.com", DASHSCOPE_API_KEY: "test",
  });
  let textRequests = 0;
  t.mock.method(globalThis, "fetch", async (url: URL) => {
    if (url.hostname.endsWith(".maas.aliyuncs.com")) return new Response(offer);
    assert.equal(url.href, "https://text.example.test/v1/chat/completions");
    textRequests++;
    return Response.json({
      choices: [{ message: { content: "Look for evidence in paragraph C." } }],
      usage: { prompt_tokens: 120, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 20 } },
    });
  });

  const app = await createLocalApp({ dataDirectory: directory, activities: [] });
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
    process.env = originalEnv;
  });

  type Browser = { account: Account; cookie: string };
  function request(path: string, browser?: Browser, method = "GET", body?: unknown, extraHeaders: Record<string, string> = {}) {
    const headers = {
      "content-type": typeof body === "string" ? "application/sdp" : "application/json",
      ...(browser && { cookie: browser.cookie, "x-ielts-account": browser.account.id }),
      ...extraHeaders,
    };
    const raw = typeof body === "string" ? body : body === undefined ? "" : JSON.stringify(body);
    return new Promise<{ status: number; headers: Map<string, string>; body: any }>((resolve, reject) => {
      const req = {
        method, url: path, headers, socket: { remoteAddress: "127.0.0.1" },
        async *[Symbol.asyncIterator]() { if (raw) yield Buffer.from(raw); },
      } as unknown as IncomingMessage;
      const outgoing = new Map<string, string>();
      let status = 200;
      let sent = false;
      const res = {
        get headersSent() { return sent; },
        setHeader(name: string, value: string) { outgoing.set(name.toLowerCase(), value); },
        writeHead(code: number, headers: Record<string, string>) {
          status = code;
          sent = true;
          for (const [name, value] of Object.entries(headers)) outgoing.set(name.toLowerCase(), value);
        },
        end(content: string) { resolve({ status, headers: outgoing, body: outgoing.get("content-type")?.includes("json") ? JSON.parse(content) : content }); },
        destroy(error: Error) { reject(error); },
      } as unknown as ServerResponse;
      app.server.emit("request", req, res);
    });
  }

  const password = "a distinct test password";
  async function register(username: string): Promise<Browser> {
    const result = await request("/api/auth/register", undefined, "POST", { username, password });
    assert.equal(result.status, 201);
    const setCookie = result.headers.get("set-cookie")!;
    assert.match(setCookie, /HttpOnly; SameSite=Strict; Max-Age=604800/);
    return { account: result.body.account, cookie: setCookie.split(";")[0]! };
  }

  assert.equal((await request("/api/bootstrap", undefined, "GET", undefined, { cookie: "ielts_demo_session=legacy" })).status, 401);
  assert.equal((await request("/api/usage")).status, 401);
  assert.equal((await request("/api/auth/session")).body.account, null);
  const a = await register("Learner-A");
  const b = await register("learner-b");
  assert.equal(a.account.username, "learner-a");
  assert.equal((await request("/api/auth/register", undefined, "POST", { username: "LEARNER-A", password })).status, 409);
  assert.equal((await request("/api/auth/login", undefined, "POST", { username: "learner-a", password: "wrong-password" })).status, 401);
  const freshLogin = await request("/api/auth/login", undefined, "POST", { username: " LEARNER-A ", password });
  assert.equal(freshLogin.status, 200);
  assert.deepEqual(freshLogin.body.account, a.account);
  assert.equal((await request("/api/bootstrap", b, "GET", undefined, { "x-ielts-account": a.account.id })).status, 401);

  const aBootstrap = (await request("/api/bootstrap", a)).body;
  const bBootstrap = (await request("/api/bootstrap", b)).body;
  assert.equal(aBootstrap.profile.id, a.account.id);
  assert.equal(bBootstrap.profile.id, b.account.id);
  assert.deepEqual(aBootstrap.activities, bBootstrap.activities);
  const activityId = "sample-reading-green-spaces";
  const attempt = await request("/api/attempts", a, "POST", { activityId, mode: "practice", userId: b.account.id });
  assert.equal(attempt.status, 201);
  const attemptPath = "/api/attempts/" + attempt.body.draft.attemptId;
  assert.equal((await request(attemptPath, a)).status, 200);
  assert.equal((await request(attemptPath, b)).status, 404);
  assert.equal((await request(attemptPath + "/abandon", b, "POST", {})).status, 404);

  const conversationId = "same-key";
  assert.equal((await request("/api/coach", a, "POST", { activityId, questionId: "read-q1", conversationId, message: "Private question" })).status, 200);
  assert.equal(textRequests, 1);
  assert.equal((await request("/api/coach/history?conversationId=same-key", a)).body.messages.length, 2);
  assert.deepEqual((await request("/api/coach/history?conversationId=same-key", b)).body.messages, []);

  const record = {
    id: crypto.randomUUID(), part: 2, topic: "Private topic", endedAt: new Date().toISOString(),
    lines: [{ id: "one", role: "learner", text: "My private response." }], feedback: null,
  };
  assert.equal((await request("/api/speaking/sessions", a, "POST", record)).status, 200);
  assert.deepEqual((await request("/api/speaking/sessions", b)).body.sessions, []);
  assert.equal((await request("/api/speaking/sessions/" + record.id, b)).status, 404);

  const answer = await request("/api/speaking/sdp", a, "POST", offer);
  assert.equal(answer.status, 200);
  const voicePath = "/api/speaking/calls/" + answer.headers.get("x-ielts-call-id") + "/usage";
  assert.equal(((await request("/api/usage", a)).body as UsageSummary).voiceCallsWithoutUsage, 1);
  const voiceEvent = {
    responseId: "resp_billed",
    usage: {
      input_tokens: 120, output_tokens: 80,
      input_tokens_details: { text_tokens: 20, audio_tokens: 100 },
      output_tokens_details: { text_tokens: 30, audio_tokens: 50 },
    },
  };
  assert.equal((await request(voicePath, b, "POST", voiceEvent)).status, 404);
  assert.equal((await request(voicePath, a, "POST", voiceEvent)).status, 200);
  assert.equal((await request(voicePath, a, "POST", voiceEvent)).status, 200);
  assert.equal((await request(voicePath, a, "POST", { responseId: "resp_missing" })).status, 200);

  const usage = (await request("/api/usage", a)).body as UsageSummary;
  assert.equal(usage.voiceCallsWithoutUsage, 0);
  assert.deepEqual(usage.models[0], {
    category: "text", model: "test-text", responses: 1, inputTokens: 120, outputTokens: 30,
    estimatedUsd: 0.00034, missingUsage: 0, missingPrice: 0,
  });
  assert.deepEqual(usage.models[1], {
    category: "voice", model: "qwen3.8-omni-flash-realtime", responses: 2, inputTokens: 120, outputTokens: 80,
    estimatedUsd: (20 * 0.212 + 100 * 0.848 + 30 * 0.636 + 50 * 1.696) / 1_000_000, missingUsage: 1, missingPrice: 0,
  });
  assert.deepEqual((await request("/api/usage", b)).body, { models: [], voiceCallsWithoutUsage: 0 });
  assert.equal((await request("/api/auth/logout", a, "POST", {}, { "sec-fetch-site": "same-site" })).status, 403);
  assert.equal((await request("/api/auth/logout", a, "POST", {})).status, 200);
  assert.equal((await request("/api/usage", a)).status, 401);
  assert.deepEqual((await request("/api/auth/session", b)).body.account, b.account);
});
