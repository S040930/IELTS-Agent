import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "@neondatabase/serverless";
import { PostgresLearningStore } from "../server/postgres-store.js";

for (const name of [".env.local", ".env"]) {
  const envFile = resolve(name);
  if (existsSync(envFile)) for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && !process.env[match[1]!]) process.env[match[1]!] = match[2]!.replace(/^(["'])(.*)\1$/, "$2");
  }
}
if (!process.env.DATABASE_URL) throw new Error("请配置 DATABASE_URL。");
const client = new Client(process.env.DATABASE_URL);
await client.connect();
try {
  await new PostgresLearningStore(client).initialize();
  console.log("Neon 数据库结构已初始化；现有学习表未清空。");
} finally { await client.end(); }
