import { test } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { LearningStore } from "../server/db.js";
import { exchangeSpeakingOffer } from "../server/services/speaking.js";
import { parseSpeakingRecord, type SpeakingRecord } from "../src/shared/speaking.js";

test("speaking history saves a retry once and only persists the supported text fields", () => {
  const record: SpeakingRecord = {
    id: crypto.randomUUID(), part: 2, topic: "A quiet place", endedAt: new Date().toISOString(),
    lines: [{ id: "one", role: "learner", text: "I often visit a park." }], feedback: null,
  };
  assert.deepEqual(parseSpeakingRecord({ ...record, recording: "unwanted" }), record);
  assert.equal(parseSpeakingRecord({ ...record, feedback: {} }), null);
  const store = new LearningStore(":memory:");
  try {
    store.saveSpeaking(record);
    store.saveSpeaking(record);
    assert.deepEqual(store.speakingRecord(record.id), record);
    assert.deepEqual(store.speakingHistory().map(row => ({ ...row })), [{ id: record.id, part: 2, topic: record.topic, endedAt: record.endedAt }]);
    assert.equal(store.attempts().length, 0);
  } finally { store.close(); }
});

test("SDP exchange pins upstream, forwards audio offer and translates provider auth errors", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: URL, init: RequestInit) => {
    assert.equal(url.href, "https://demo.cn-beijing.maas.aliyuncs.com/api/v1/webrtc/realtime?model=qwen3.8-omni-flash-realtime");
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer test");
    assert.equal(init.body, offer);
    return new Response(offer);
  });
  const key = process.env.DASHSCOPE_API_KEY;
  const host = process.env.IELTS_REALTIME_HOST;
  const offer = "v=0\r\nm=audio 9 RTP/AVP 0\r\n";
  const request = { headers: { "content-type": "application/sdp" }, async *[Symbol.asyncIterator]() { yield Buffer.from(offer); } } as unknown as IncomingMessage;
  try {
    process.env.DASHSCOPE_API_KEY = "test";
    process.env.IELTS_REALTIME_HOST = "demo.cn-beijing.maas.aliyuncs.com";
    assert.equal(await exchangeSpeakingOffer(request), offer);
    t.mock.method(globalThis, "fetch", async () => new Response("", { status: 401 }));
    await assert.rejects(exchangeSpeakingOffer(request), /鉴权失败/);
    delete process.env.DASHSCOPE_API_KEY;
    await assert.rejects(exchangeSpeakingOffer(request), /DASHSCOPE_API_KEY/);
  } finally {
    if (key === undefined) delete process.env.DASHSCOPE_API_KEY; else process.env.DASHSCOPE_API_KEY = key;
    if (host === undefined) delete process.env.IELTS_REALTIME_HOST; else process.env.IELTS_REALTIME_HOST = host;
  }
});
