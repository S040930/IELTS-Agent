import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { Transform } from "node:stream";
import { Readable } from "node:stream";
import { Client } from "@neondatabase/serverless";
import { del, put } from "@vercel/blob";
import type { Activity } from "../src/shared/domain.js";
import { assertActivity } from "../src/shared/validation.js";

function loadLocalEnv(): void {
  for (const name of [".env.local", ".env"]) {
    const file = resolve(name);
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (match && !process.env[match[1]!]) process.env[match[1]!] = match[2]!.replace(/^(["'])(.*)\1$/, "$2");
    }
  }
}
const mime: Record<string, string> = { ".wav": "audio/wav", ".m4a": "audio/mp4", ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".webm": "audio/webm" };
const audioName = (url: string) => {
  const match = url.match(/^\/media\/([a-f0-9-]{36}\.(?:wav|m4a|mp3|ogg|webm))$/i);
  if (!match) throw new Error(`音频引用格式不支持：${url}`);
  return match[1]!;
};

loadLocalEnv();
const databaseUrl = process.env.DATABASE_URL;
const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
if (!databaseUrl || !blobToken) throw new Error("请配置 DATABASE_URL 和 BLOB_READ_WRITE_TOKEN。");
const flags = new Set(process.argv.slice(2));
const prune = flags.has("--prune");
const applyPrune = flags.has("--yes");
if (applyPrune && !prune) throw new Error("--yes 只能和 --prune 一起使用。");
const catalogPath = resolve(process.env.IELTS_CONTENT_CATALOG ?? ".data/content/activities.json");
const mediaDirectory = resolve(process.env.IELTS_MEDIA_DIR ?? ".data/media");
const catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as { version?: unknown; activities?: unknown };
if (catalog.version !== 1 || !Array.isArray(catalog.activities)) throw new Error("题库清单格式无效。");
const activities: Activity[] = [];
const ids = new Set<string>();
const media = new Map<string, string>();
let excludedListeningActivities = 0;
for (const candidate of catalog.activities) {
  assertActivity(candidate);
  const activity = candidate as Activity;
  if (ids.has(activity.id)) throw new Error(`练习 ID 重复：${activity.id}`);
  ids.add(activity.id);
  const frequency = activity.description.split("·").map((tag) => tag.trim()).find((tag) => ["高频", "次高频", "非高频"].includes(tag));
  if (activity.pluginId === "listening" && frequency !== "高频" && frequency !== "次高频") {
    excludedListeningActivities++;
    continue;
  }
  activities.push(activity);
  for (const url of [activity.audioUrl, ...(activity.audioSections ?? []).map((section) => section.audioUrl)].filter((item): item is string => Boolean(item))) {
    const name = audioName(url); const path = join(mediaDirectory, name);
    if (!existsSync(path)) throw new Error(`活动「${activity.title}」缺少音频：${name}`);
    media.set(name, path);
  }
}
if (!activities.length) throw new Error("题库清单没有活动。");
if (!media.size) throw new Error("题库清单没有音频引用。");
console.log(`云端题库筛选：排除 ${excludedListeningActivities} 份非高频/未标频听力练习；本机题库清单未修改。`);
for (const name of await readdir(mediaDirectory)) if (media.has(name) && !mime[extname(name).toLowerCase()]) throw new Error(`音频类型不支持：${name}`);

const client = new Client(databaseUrl);
await client.connect();
try {
  const { PostgresLearningStore } = await import("../server/postgres-store.js");
  const store = new PostgresLearningStore(client);
  await store.initialize();
  let uploaded = 0;
  for (const [name, path] of media) {
    const hash = createHash("sha256");
    const hashingStream = new Transform({ transform(chunk: Buffer, _encoding, callback) { hash.update(chunk); callback(null, chunk); } });
    const source = createReadStream(path).pipe(hashingStream);
    const result = await put(`media/${name}`, Readable.toWeb(source) as ReadableStream<Uint8Array>, {
      access: "private", token: blobToken, contentType: mime[extname(name).toLowerCase()],
      addRandomSuffix: false, allowOverwrite: true,
    });
    const sha256 = hash.digest("hex");
    await client.query(`INSERT INTO media_assets (pathname,content_type,size_bytes,sha256) VALUES ($1,$2,$3,$4)
      ON CONFLICT (pathname) DO UPDATE SET content_type=EXCLUDED.content_type,size_bytes=EXCLUDED.size_bytes,sha256=EXCLUDED.sha256`, [`media/${name}`, mime[extname(name).toLowerCase()], statSync(path).size, sha256]);
    uploaded++;
    console.log(`音频 ${uploaded}/${media.size} 已上传：${name} (${Math.round(statSync(path).size / 1024 / 1024)} MB)`);
    void result;
  }
  const count = await store.importActivities(activities);
  console.log(`完成：已导入 ${count} 份练习、${uploaded} 个私有音频。个人学习记录没有参与导入。`);
  if (prune) {
    const keepActivities = new Set(activities.map((activity) => activity.id));
    const activityRows = await client.query("SELECT id FROM imported_activities");
    const staleActivities = (activityRows.rows as Array<{ id: string }>).map((row) => row.id).filter((id) => !keepActivities.has(id));
    const keepMedia = new Set([...media.keys()].map((name) => `media/${name}`));
    const mediaRows = await client.query("SELECT pathname FROM media_assets");
    const staleMedia = (mediaRows.rows as Array<{ pathname: string }>).map((row) => row.pathname).filter((pathname) => !keepMedia.has(pathname));
    console.log(`清理预览：${staleActivities.length} 份练习、${staleMedia.length} 个音频不在本次清单内。`);
    for (const id of staleActivities.slice(0, 20)) console.log(`  练习 ${id}`);
    for (const pathname of staleMedia.slice(0, 20)) console.log(`  音频 ${pathname}`);
    if (!applyPrune) {
      console.log("这是预演，尚未删除；确认无误后加 --yes 执行清理。");
    } else {
      let removedActivities = 0;
      let removedMedia = 0;
      const failures: string[] = [];
      for (const id of staleActivities) {
        try { await client.query("DELETE FROM imported_activities WHERE id=$1", [id]); removedActivities++; }
        catch (error) { failures.push(`练习 ${id}: ${error instanceof Error ? error.message : String(error)}`); }
      }
      for (const pathname of staleMedia) {
        try {
          await del(pathname, { token: blobToken });
          await client.query("DELETE FROM media_assets WHERE pathname=$1", [pathname]);
          removedMedia++;
        } catch (error) { failures.push(`音频 ${pathname}: ${error instanceof Error ? error.message : String(error)}`); }
      }
      console.log(`清理完成：删除 ${removedActivities} 份练习、${removedMedia} 个音频。`);
      if (failures.length) {
        console.error(`有 ${failures.length} 项清理失败：`);
        for (const failure of failures) console.error(`  ${failure}`);
      }
    }
  } else {
    console.log("提示：运行 npm run content:upload-cloud -- --prune 可预览清理清单外的云端内容。");
  }
} finally { await client.end(); }
