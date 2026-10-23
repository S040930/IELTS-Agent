import { existsSync, mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join, resolve } from "node:path";
import type { Activity } from "../src/shared/domain.js";
import { assertActivity } from "../src/shared/validation.js";

/**
 * 修复 Margaret Mahy（Reading Passage 3）的题号。
 *
 * 源文件 PASSAGE-by-ZYZ-IELTS-Reading-2026-10-01-r1.html 的任务组元数据：
 *   task.choice.margaret.ynng         -> "Questions 27–31"  YES / NO / NOT GIVEN   5 题
 *   task.summary.p2                   -> "Questions 32–35"  Summary Completion   4 题
 *   task.choice.margaret.single-choice-> "Questions 36–40"  Multiple Choice      5 题
 * 段位："READING PASSAGE 3"（ordinal=3），instruction "answer Questions 27–40."
 *
 * 导入时把前 10 道题重新编号成 1-5（各重复两次），导致 min=1/max=35 跨越两个区间，
 * 无法判定段位。此脚本按源文件任务组恢复真实题号，并补上 part=3。
 */

const dataDirectory = resolve(process.env.IELTS_DATA_DIR ?? ".data");
const databasePath = join(dataDirectory, "learning.sqlite");
const activityId = "zyz-71f95cb41a2d98a57a2a30ed";

/** 源文件任务组 -> 题号区间（闭区间） */
const groups = [
  { prefix: "score.choice.margaret.ynng.q", start: 27, count: 5, label: "Questions 27–31", type: "YES / NO / NOT GIVEN" },
  { prefix: "score.summary.p2.g", start: 32, count: 4, label: "Questions 32–35", type: "Summary Completion" },
  { prefix: "score.choice.margaret.single-choice.q", start: 36, count: 5, label: "Questions 36–40", type: "Multiple Choice" },
] as const;

const apply = process.argv.slice(2).includes("--apply");
const backupPath = process.argv.slice(2).find((value) => value.startsWith("--backup="))?.slice("--backup=".length);

if (!existsSync(databasePath)) throw new Error(`找不到题库来源数据库：${databasePath}`);
if (backupPath && !apply) throw new Error("--backup= 只能与 --apply 一起使用。");
if (backupPath && existsSync(resolve(backupPath))) throw new Error(`备份文件已存在，请换一个路径：${backupPath}`);

const database = new DatabaseSync(databasePath, { readOnly: !apply });
const row = database.prepare("SELECT activity_json FROM imported_activities WHERE id=?").get(activityId) as { activity_json: string } | undefined;
if (!row) throw new Error(`题库中没有活动 ${activityId}`);
const activity = JSON.parse(row.activity_json) as Activity;

if (activity.pluginId !== "reading") throw new Error(`活动 ${activityId} 不是阅读练习（实际 ${activity.pluginId}），已中止。`);

const numbering = new Map<string, number>();
for (const group of groups) {
  for (let index = 0; index < group.count; index += 1) numbering.set(`${group.prefix}${String(index + 1).padStart(2, "0")}`, group.start + index);
}

const unmapped = activity.questions.filter((question) => !numbering.has(question.id));
if (unmapped.length) throw new Error(`有题目无法映射到源文件任务组：${unmapped.map((question) => question.id).join(", ")}`);

const before = activity.questions.map((question) => `${question.displayNumber}· ${question.id}`);
const after = activity.questions.map((question) => `${numbering.get(question.id)}· ${question.id}`);
const numbers = [...numbering.values()].sort((a, b) => a - b);
const expected = Array.from({ length: 14 }, (_, index) => 27 + index);
if (numbers.length !== 14 || numbers.some((value, index) => value !== expected[index])) {
  throw new Error(`重排后题号不是连续的 27-40：${numbers.join(",")}`);
}

console.log("\nMargaret Mahy 题号修复 · %s", apply ? "写入模式" : "预览模式（未写入任何数据）");
console.log(`活动：${activityId}\n标题：${activity.title}\n`);
for (const group of groups) console.log(`  ${group.label.padEnd(15)} ${group.type.padEnd(22)} ${group.count} 题   ← ${group.prefix}*`);
console.log(`\n段位：未标注 → 3（READING PASSAGE 3，源文件 passagePosition=3）\n`);
console.log("题号变更：");
for (let index = 0; index < before.length; index += 1) {
  const [from, id] = [before[index]!.split("· ")[0], activity.questions[index]!.id];
  const to = after[index]!.split("· ")[0];
  const flag = from === to ? "  " : "→";
  console.log(`  ${from.padStart(3)} ${flag} ${to.padEnd(3)}  ${id}`);
}

if (!apply) {
  database.close();
  console.log("\n以上为预览。确认无误后加 --apply 才会写入数据库。");
  process.exit(0);
}

if (backupPath) {
  const target = resolve(backupPath);
  mkdirSync(dirname(target), { recursive: true });
  database.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  console.log(`\n已备份数据库（一致性快照）：${target}`);
}

const next: Activity = {
  ...activity,
  part: 3,
  questions: activity.questions
    .map((question) => ({ ...question, displayNumber: numbering.get(question.id) }))
    .sort((a, b) => a.displayNumber! - b.displayNumber!),
};
assertActivity(next);

try {
  database.exec("BEGIN IMMEDIATE");
  database.prepare("UPDATE imported_activities SET activity_json=? WHERE id=?").run(JSON.stringify(next), activityId);
  database.exec("COMMIT");
} catch (error) {
  database.exec("ROLLBACK");
  database.close();
  throw error;
}
database.close();

console.log(`\n已写入：14 道题题号恢复为 27-40，part 标记为 3（imported_at 未改动）。`);
console.log("下一步：npm run content:tag-parts  # 确认段位可被自动推断");
console.log("然后：  npm run content:export       # 重新产出内容包");
console.log("最后重启本机服务。");