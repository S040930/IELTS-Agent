import { existsSync, mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join, resolve } from "node:path";
import type { Activity } from "../src/shared/domain.js";
import { assertActivity } from "../src/shared/validation.js";

const dataDirectory = resolve(process.env.IELTS_DATA_DIR ?? ".data");
const databasePath = join(dataDirectory, "learning.sqlite");

type Part = 1 | 2 | 3 | 4;
type PartSource = "description" | "range" | "title" | "none";

interface Decision {
  part?: Part;
  source: PartSource;
  /** 多个来源给出一致结果 */
  agreed: boolean;
  /** 各来源给出的候选，供报告展示冲突 */
  candidates: Part[];
}

const arguments_ = process.argv.slice(2);
const apply = arguments_.includes("--apply");
const backupPath = arguments_.find((value) => value.startsWith("--backup="))?.slice("--backup=".length);

const toPart = (value: string | undefined): Part | undefined => {
  const parsed = Number(value);
  return parsed >= 1 && parsed <= 4 && Number.isInteger(parsed) ? (parsed as Part) : undefined;
};

const questionNumbers = (activity: Activity): number[] =>
  activity.questions
    .map((question) => question.displayNumber)
    .filter((value): value is number => typeof value === "number");

/** 听力：description 最权威，题号区间次之，标题最后兜底（个别标题写错了 Part 号）。 */
function inferListeningPart(activity: Activity): Decision {
  const fromDescription = toPart(activity.description?.match(/Part\s*([1-4])/)?.[1]);
  const numbers = questionNumbers(activity);
  const fromRange: Part | undefined = numbers.length === activity.questions.length && numbers.length
    ? (Math.floor((Math.min(...numbers) - 1) / 10) + 1) as Part
    : undefined;
  const fromTitle = toPart(activity.title?.match(/\bP([1-4])\b/)?.[1]);
  const candidates = [fromDescription, fromRange, fromTitle].filter((value): value is Part => value !== undefined);
  const part = fromDescription ?? fromRange ?? fromTitle;
  if (part === undefined) return { source: "none", agreed: false, candidates };
  const source: PartSource = part === fromDescription ? "description" : part === fromRange ? "range" : "title";
  return { part, source, agreed: candidates.length > 1 && new Set(candidates).size === 1, candidates };
}

/** 阅读：没有文本标记，只能按题号区间完整包含判定（只看最小题号会把跨段活动误归 Passage 1）。 */
function inferReadingPart(activity: Activity): Decision {
  const numbers = questionNumbers(activity);
  if (!numbers.length || numbers.length !== activity.questions.length) return { source: "none", agreed: false, candidates: [] };
  const min = Math.min(...numbers);
  const max = Math.max(...numbers);
  const part: Part | undefined = min >= 1 && max <= 13 ? 1 : min >= 14 && max <= 26 ? 2 : min >= 27 && max <= 40 ? 3 : undefined;
  return part === undefined ? { source: "none", agreed: false, candidates: [] } : { part, source: "range", agreed: true, candidates: [part] };
}

function inferPart(activity: Activity): Decision {
  if (activity.pluginId === "listening") return inferListeningPart(activity);
  if (activity.pluginId === "reading") return inferReadingPart(activity);
  return { source: "none", agreed: false, candidates: [] };
}

if (!existsSync(databasePath)) throw new Error(`找不到题库来源数据库：${databasePath}`);
if (backupPath && !apply) throw new Error("--backup= 只能与 --apply 一起使用。");
if (backupPath && existsSync(resolve(backupPath))) throw new Error(`备份文件已存在，请换一个路径：${backupPath}`);

const database = new DatabaseSync(databasePath, { readOnly: !apply });
const rows = database.prepare("SELECT id, plugin_id, activity_json FROM imported_activities ORDER BY imported_at, id")
  .all() as Array<{ id: string; plugin_id: string; activity_json: string }>;

interface Update { id: string; title: string; activity: Activity; decision: Decision; numbers: number[] }

const updates: Update[] = [];
const conflicts: Update[] = [];
const unresolved: Update[] = [];
const skipped = { vocabulary: 0, unchanged: 0 };
const counts = { listening: new Map<number, number>(), reading: new Map<number, number>() };

for (const row of rows) {
  const activity = JSON.parse(row.activity_json) as Activity;
  if (activity.pluginId === "vocabulary") { skipped.vocabulary += 1; continue; }
  const decision = inferPart(activity);
  const record: Update = { id: row.id, title: activity.title, activity, decision, numbers: questionNumbers(activity) };
  if (decision.part === undefined) { unresolved.push(record); continue; }
  const section = activity.pluginId as "listening" | "reading";
  counts[section].set(decision.part, (counts[section].get(decision.part) ?? 0) + 1);
  if (!decision.agreed) conflicts.push(record);
  if (activity.part === decision.part) { skipped.unchanged += 1; continue; }
  updates.push(record);
}

const formatCounts = (label: string, map: Map<number, number>, names: string[]) =>
  `${label}  ${[1, 2, 3, 4].filter((part) => map.has(part)).map((part) => `${names[part - 1]} ${map.get(part)} 份`).join("   ")}`;

console.log(`\n题库分段标注 · ${apply ? "写入模式" : "预览模式（未写入任何数据）"}`);
console.log(`数据库：${databasePath}   活动总数：${rows.length}\n`);
console.log(`${formatCounts("听力 Part（description 优先）    ", counts.listening, ["Part 1", "Part 2", "Part 3", "Part 4"])}   小计 ${[...counts.listening.values()].reduce((sum, value) => sum + value, 0)} 份`);
console.log(`${formatCounts("阅读 Passage（题号区间判定）   ", counts.reading, ["Passage 1", "Passage 2", "Passage 3"])}   小计 ${[...counts.reading.values()].reduce((sum, value) => sum + value, 0)} 份\n`);

if (conflicts.length) {
  console.log("标题与结构不一致（以 description / 题号区间为准，请人工确认）：");
  for (const item of conflicts) console.log(`  ${item.id}\n    标题：${item.title}\n    判定：Part ${item.decision.part}（来源 ${item.decision.source}）各来源给出：${item.decision.candidates.join(" / ")}\n    题号：${item.numbers.join(",")}\n`);
}
if (unresolved.length) {
  console.log("无法判定（保持原样，不写入part）：");
  for (const item of unresolved) console.log(`  ${item.id}  ${item.title}\n    题号：${item.numbers.join(",")} 跨越多个段落，无法归入 Passage 1/2/3\n`);
}
console.log(`词汇区块：${skipped.vocabulary} 份（无 Part 概念，跳过）`);
console.log(`已是目标分段、无需改动：${skipped.unchanged} 份`);
console.log(`将写入 part 的活动：${updates.length} 份\n`);

if (!apply) {
  database.close();
  console.log("以上为预览。确认无误后加 --apply 才会写入数据库。");
  process.exit(0);
}

if (backupPath) {
  // 用 VACUUM INTO 做一致性快照：库开着 WAL，直接拷贝主文件会漏掉尚未 checkpoint 的已提交数据。
  const target = resolve(backupPath);
  mkdirSync(dirname(target), { recursive: true });
  database.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  console.log(`已备份数据库（一致性快照）：${target}`);
}

try {
  database.exec("BEGIN IMMEDIATE");
  const update = database.prepare("UPDATE imported_activities SET activity_json=? WHERE id=?");
  for (const item of updates) {
    const next = { ...item.activity, part: item.decision.part };
    assertActivity(next);
    update.run(JSON.stringify(next), item.id);
  }
  database.exec("COMMIT");
} catch (error) {
  database.exec("ROLLBACK");
  database.close();
  throw error;
}
database.close();

console.log(`已写入 ${updates.length} 份活动的 part 字段（imported_at 保持不变）。`);
console.log("下一步：npm run content:export 重新生成 activities.json 与内容包");
console.log("然后重启本机服务（npm run dev / npm start），前端才会读到新的 part 字段。");