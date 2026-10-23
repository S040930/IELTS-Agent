import { mkdirSync, writeFileSync, existsSync, statSync, unlinkSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { join, resolve, sep } from "node:path";
import type { Activity } from "../src/shared/domain.js";
import { assertActivity } from "../src/shared/validation.js";

const dataDirectory = resolve(process.env.IELTS_DATA_DIR ?? ".data");
const databasePath = join(dataDirectory, "learning.sqlite");
const manifestDirectory = join(dataDirectory, "content");
const manifestPath = join(manifestDirectory, "activities.json");
const archivePath = join(dataDirectory, "ielts-content-v1.tar");

if (!existsSync(databasePath)) throw new Error(`找不到题库来源数据库：${databasePath}`);
const database = new DatabaseSync(databasePath, { readOnly: true });
let activities: Activity[];
try {
  activities = (database.prepare("SELECT activity_json FROM imported_activities ORDER BY imported_at, id").all() as Array<{ activity_json: string }>)
    .map((row) => JSON.parse(row.activity_json) as Activity);
} finally {
  database.close();
}
if (!activities.length) throw new Error("数据库中没有可导出的练习题库。");
for (const activity of activities) assertActivity(activity);

const mediaDirectory = resolve(dataDirectory, "media");
const referencedMedia = new Set<string>();
for (const activity of activities) {
  const urls = [activity.audioUrl, ...(activity.audioSections ?? []).map((section) => section.audioUrl)].filter((url): url is string => Boolean(url));
  for (const url of urls) {
    const match = url.match(/^\/media\/([a-f0-9-]{36}\.(?:wav|m4a|mp3|ogg|webm))$/i);
    if (!match) throw new Error(`练习「${activity.title}」的音频路径不符合内容包格式：${url}`);
    const filename = match[1]!;
    const mediaPath = resolve(mediaDirectory, filename);
    if (!mediaPath.startsWith(mediaDirectory + sep) || !existsSync(mediaPath) || !statSync(mediaPath).isFile()) {
      throw new Error(`练习「${activity.title}」缺少音频文件：${filename}`);
    }
    referencedMedia.add(filename);
  }
}

mkdirSync(manifestDirectory, { recursive: true });
writeFileSync(manifestPath, JSON.stringify({ version: 1, activities }, null, 2) + "\n");
const fileListPath = join(dataDirectory, "content-package-files.txt");
writeFileSync(fileListPath, ["content/activities.json", ...[...referencedMedia].sort().map((name) => `media/${name}`)].join("\n") + "\n");
const archive = spawnSync("tar", ["-cf", archivePath, "-C", dataDirectory, "-T", fileListPath], { stdio: "inherit" });
if (archive.error) { if (existsSync(archivePath)) unlinkSync(archivePath); throw archive.error; }
if (archive.status !== 0) { if (existsSync(archivePath)) unlinkSync(archivePath); throw new Error(`tar 导出失败，退出码 ${archive.status}`); }
console.log(`已导出 ${activities.length} 份练习、${referencedMedia.size} 个音频文件：${archivePath}`);
console.log("归档内容仅包含 content/activities.json 和 media/ 下被题库引用的音频。");
