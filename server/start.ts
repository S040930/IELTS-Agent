import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createApp } from "./index.js";

async function loadLocalEnvironment(): Promise<void> {
  let contents: string;
  try { contents = await readFile(resolve(process.cwd(), ".env"), "utf8"); }
  catch { return; }
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match || process.env[match[1]!]) continue;
    let value = match[2]!.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[match[1]!] = value;
  }
}

await loadLocalEnvironment();
const { server, close } = await createApp({ production: process.argv.includes("--production") });
const port = Number(process.env.IELTS_SERVER_PORT ?? 4173);
server.listen(port, "127.0.0.1", () => {
  process.stdout.write("IELTS local service listening at http://127.0.0.1:" + port + "\n");
});
let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  await close();
  process.exit(0);
}
process.on("SIGINT", () => { void shutdown(); });
process.on("SIGTERM", () => { void shutdown(); });
