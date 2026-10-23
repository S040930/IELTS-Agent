import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join, resolve } from "node:path";
import type { Activity } from "../src/shared/domain.js";
import { assertActivity } from "../src/shared/validation.js";

/**
 * 回填阅读选项的列表文本。
 *
 * 导入题库时，matching-features / classification / matching-sentence-endings 三类题的
 * optionLabels 只写入了重复字母（"A. A"、"B. B"），列表正文在导入环节丢失，
 * 练习页只能渲染成 A、B、C、D。reading.matching-information（段落题）选项本来就是
 * 段落字母 A–H，属于正常考法，本脚本不动。
 *
 * 正文来源：官方题库网页 PASSAGE-by-ZYZ-IELTS-Reading-*.html。网页把全部题目打包在
 * <script id="zyz-integrity-payload" type="application/octet-stream"> 里（base64），
 * 任务组选项形如：
 *   {"optionId":"option.b005.p2-048.features.01","label":"A","text":"Anthony Pellegrini"}
 * 用 --source=<网页文件路径> 指定；也可用 --options=<json> 直接喂已导出的选项表。
 *
 * 默认只预览；确认无误后加 --apply 写入。--backup= 用 SQLite VACUUM INTO 做一致性快照
 * （库开着 WAL，直接拷贝主文件会漏数据）。
 *
 *   npm run content:fix-option-labels -- --source=~/Downloads/....html
 *   npm run content:fix-option-labels -- --source=... --apply --backup=.data/backups/learning-before-option-labels.sqlite
 *   npm run content:export
 */

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
/** 选项标签里没有实质文本：剥掉 "A. " 前缀后为空，或只剩字母本身。 */
const TEXT_REQUIRED_TAGS = new Set([
  "reading.matching-features",
  "reading.classification",
  "reading.matching-sentence-endings",
]);

function isMissingText(label: string): boolean {
  const body = label.replace(/^[A-Z]\s*[.)]\s*/, "").trim();
  return body === "" || /^[A-Z]$/.test(body);
}

/** 从官方题库网页的 base64 负载里取出 optionId -> { label, text }。 */
function extractOptionsFromHtml(html: string): Map<string, { label: string; text: string }> {
  const open = html.indexOf('<script id="zyz-integrity-payload"');
  if (open === -1) throw new Error("网页里没有 zyz-integrity-payload，找不到这份文件是不是题库网页？");
  const start = html.indexOf(">", open) + 1;
  const end = html.indexOf("</script>", start);
  if (end === -1) throw new Error("zyz-integrity-payload 没有正常闭合，网页文件可能不完整。");

  const decoded = Buffer.from(html.slice(start, end).trim(), "base64").toString("utf8");
  // 选项对象后面可能跟 sourceBlockId 等字段，因此只匹配前三个键。
  const pattern = /\{"optionId":"([^"]+)","label":"((?:[^"\\]|\\.)*)","text":"((?:[^"\\]|\\.)*)"/g;
  const options = new Map<string, { label: string; text: string }>();
  for (const match of decoded.matchAll(pattern)) {
    const optionId = match[1]!;
    if (options.has(optionId)) continue;
    options.set(optionId, { label: match[2]!, text: match[3]! });
  }
  if (!options.size) throw new Error("网页里没有解析出任何选项，格式可能变了，请人工核对。");
  return options;
}

function loadSource(sourcePath: string | undefined, optionsPath: string | undefined): Map<string, { label: string; text: string }> {
  if (optionsPath) {
    const parsed = JSON.parse(readFileSync(resolve(optionsPath), "utf8")) as Array<{ optionId: string; label: string; text: string }>;
    return new Map(parsed.map((item) => [item.optionId, { label: item.label, text: item.text }]));
  }
  if (!sourcePath) throw new Error("请用 --source=<题库网页.html> 或 --options=<选项.json> 指定正文来源。");
  return extractOptionsFromHtml(readFileSync(resolve(sourcePath), "utf8"));
}

const dataDirectory = resolve(process.env.IELTS_DATA_DIR ?? ".data");
const databasePath = join(dataDirectory, "learning.sqlite");
const args = process.argv.slice(2);
const sourcePath = args.find((value) => value.startsWith("--source="))?.slice("--source=".length);
const optionsPath = args.find((value) => value.startsWith("--options="))?.slice("--options=".length);
const apply = args.includes("--apply");
const backupPath = args.find((value) => value.startsWith("--backup="))?.slice("--backup=".length);

if (!existsSync(databasePath)) throw new Error(`找不到题库来源数据库：${databasePath}`);
if (backupPath && !apply) throw new Error("--backup= 只能与 --apply 一起使用。");
if (backupPath && existsSync(resolve(backupPath))) throw new Error(`备份文件已存在，请换一个路径：${backupPath}`);

const known = loadSource(sourcePath, optionsPath);

const database = new DatabaseSync(databasePath, { readOnly: !apply });
const rows = database.prepare("SELECT id, activity_json FROM imported_activities").all() as Array<{ id: string; activity_json: string }>;

let patchedQuestions = 0;
let patchedOptions = 0;
let paragraphLeftAlone = 0;
const unresolved: string[] = [];
const updates: Array<{ id: string; activity: Activity }> = [];

for (const row of rows) {
  const activity = JSON.parse(row.activity_json) as Activity;
  if (activity.pluginId !== "reading") continue;

  let changed = false;
  const questions = activity.questions.map((question) => {
    const tag = question.skillTags?.[0] ?? "";
    const labels = question.optionLabels;
    if (!labels || !question.options?.length) return question;

    if (!TEXT_REQUIRED_TAGS.has(tag)) {
      // 段落题等：选项合法地只有字母，确认一下没被误判即可。
      if (tag === "reading.matching-information") paragraphLeftAlone += 1;
      return question;
    }

    const optionLabels: Record<string, string> = { ...labels };
    let questionChanged = false;
    question.options.forEach((optionId, index) => {
      const current = String(optionLabels[optionId] ?? "");
      if (!isMissingText(current)) return;
      const found = known.get(optionId);
      if (!found?.text?.trim()) { unresolved.push(`${activity.id} · ${question.id} · ${optionId}`); return; }
      optionLabels[optionId] = `${LETTERS[index] ?? found.label}. ${found.text.trim()}`;
      questionChanged = true;
      patchedOptions += 1;
    });

    if (!questionChanged) return question;
    changed = true;
    patchedQuestions += 1;
    return { ...question, optionLabels };
  });

  if (!changed) continue;
  const next: Activity = { ...activity, questions };
  assertActivity(next);
  updates.push({ id: row.id, activity: next });
}

console.log("\n阅读选项正文回填 · %s", apply ? "写入模式" : "预览模式（未写入任何数据）");
console.log(`来源：${optionsPath ?? sourcePath}`);
console.log(`来源选项数：${known.size}`);
console.log(`回填题数：${patchedQuestions}　回填选项数：${patchedOptions}`);
console.log(`段落题（matching-information）保持原样：${paragraphLeftAlone} 题\n`);

if (unresolved.length) {
  console.log(`⚠ 仍有 ${unresolved.length} 个选项未找到正文：`);
  for (const item of unresolved.slice(0, 20)) console.log(`    ${item}`);
  if (unresolved.length > 20) console.log(`    … 其余 ${unresolved.length - 20} 条省略`);
  console.log("");
}

if (!updates.length) {
  database.close();
  console.log("没有需要修改的活动。");
  process.exit(0);
}

if (!apply) {
  database.close();
  console.log("以上为预览。确认无误后加 --apply 才会写入数据库。");
  process.exit(0);
}

if (backupPath) {
  const target = resolve(backupPath);
  mkdirSync(dirname(target), { recursive: true });
  const media = resolve(dataDirectory);
  if (target.startsWith(join(media, "content")) || target.startsWith(join(media, "media"))) {
    throw new Error("备份路径不能放在 .data/content/ 或 .data/media/ 下，这两个目录会被 content:export 收进归档。");
  }
  database.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  console.log(`已备份数据库（一致性快照）：${target}`);
}

try {
  database.exec("BEGIN IMMEDIATE");
  const update = database.prepare("UPDATE imported_activities SET activity_json=? WHERE id=?");
  for (const item of updates) update.run(JSON.stringify(item.activity), item.id);
  database.exec("COMMIT");
} catch (error) {
  database.exec("ROLLBACK");
  database.close();
  throw error;
}
database.close();

console.log(`已写入 ${updates.length} 份练习（imported_at 未改动，导出顺序不变）。`);
console.log("下一步：npm run content:export    # 重新产出内容包");
console.log("然后重启本机服务。");
