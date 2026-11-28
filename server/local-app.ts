import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AccountsStore, initializeAccounts, sqliteQuery } from "./accounts-store.js";
import { createApp, type ServerOptions } from "./index.js";

export async function createLocalApp(options: Pick<ServerOptions, "dataDirectory" | "production" | "activities"> = {}) {
  const dataDirectory = resolve(options.dataDirectory ?? process.env.IELTS_DATA_DIR ?? ".data");
  mkdirSync(dataDirectory, { recursive: true });
  const database = new DatabaseSync(join(dataDirectory, "accounts.sqlite"));
  try {
    database.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    const query = sqliteQuery(database);
    await initializeAccounts(query);
    const app = await createApp({ ...options, dataDirectory, localAccounts: new AccountsStore(query) });
    return {
      server: app.server,
      close: async () => {
        try { await app.close(); }
        finally { database.close(); }
      },
    };
  } catch (error) {
    database.close();
    throw error;
  }
}
