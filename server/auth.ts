import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Account } from "../src/shared/accounts.js";
import { AccountsStore } from "./accounts-store.js";
import { HttpError } from "./http-error.js";
import { readJson, sendJson } from "./http-json.js";

const cookieName = "ielts_account_session";
const sessionSeconds = 7 * 86_400;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function tokenHash(req: IncomingMessage): string | undefined {
  const token = req.headers.cookie?.split(";").map((part) => part.trim())
    .find((part) => part.startsWith(cookieName + "="))?.slice(cookieName.length + 1);
  return token && /^[a-zA-Z0-9_-]{43}$/.test(token) ? hash(token) : undefined;
}

async function passwordHash(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, { N: 32_768, maxmem: 64 * 1024 * 1024 }, (error, digest) => {
      if (error) reject(error);
      else resolve(digest);
    });
  });
}

export async function authenticate(req: IncomingMessage, res: ServerResponse, path: string,
  store: AccountsStore, secure: boolean): Promise<Account | undefined> {
  const method = req.method ?? "GET";
  const previous = tokenHash(req);
  const cookie = (token: string, seconds: number) =>
    `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${seconds}${secure ? "; Secure" : ""}`;

  // Same-site sibling origins must not act on a browser session either.
  const fetchSite = req.headers["sec-fetch-site"];
  if (method !== "GET" && method !== "HEAD" && (fetchSite === "cross-site" || fetchSite === "same-site")) {
    throw new HttpError("请在当前网站操作。", 403);
  }
  if (path === "/api/auth/session" && method === "GET") {
    sendJson(res, 200, { account: previous ? await store.session(previous) : null });
    return;
  }
  if (path === "/api/auth/logout" && method === "POST") {
    const expected = req.headers["x-ielts-account"];
    if (previous && expected && (await store.session(previous))?.id !== expected) {
      throw new HttpError("会话已变更，请重新打开学习空间。", 401);
    }
    if (previous) await store.endSession(previous);
    res.setHeader("Set-Cookie", cookie("", 0));
    sendJson(res, 200, { account: null });
    return;
  }
  if ((path === "/api/auth/login" || path === "/api/auth/register") && method === "POST") {
    const register = path.endsWith("/register");
    if (req.headers["content-type"]?.split(";")[0] !== "application/json") throw new HttpError("请使用 JSON 提交账号。", 415);
    const body = await readJson(req, 4096);
    const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)) throw new HttpError("用户名需为 3–32 位英文字母、数字、点、下划线或连字符，并以字母或数字开头。");
    if (password.length < (register ? 12 : 1) || Buffer.byteLength(password) > 256) {
      throw new HttpError(register ? "密码至少 12 个字符，且最多 256 字节。" : "请输入有效密码。");
    }
    const forwarded = secure ? String(req.headers["x-vercel-forwarded-for"] ?? "").split(",").at(-1)?.trim() : undefined;
    const source = forwarded || req.socket.remoteAddress || "unknown";
    if (!await store.allowAuthRequest(hash(path + ":" + source), register ? 10 : 30)) {
      throw new HttpError("尝试次数较多，请稍后再试。", 429);
    }
    let account: Account;
    if (register) {
      account = { id: randomUUID(), username };
      const salt = randomBytes(16).toString("hex");
      const digest = await passwordHash(password, salt);
      if (!await store.createAccount(account, salt + ":" + digest.toString("hex"))) {
        throw new HttpError("这个用户名已被使用。", 409);
      }
    } else {
      const stored = await store.findAccount(username);
      const [salt, digest] = stored?.passwordHash.split(":") ?? ["00000000000000000000000000000000", "00".repeat(64)];
      const matches = timingSafeEqual(Buffer.from(digest!, "hex"), await passwordHash(password, salt!));
      if (!stored || !matches) throw new HttpError("用户名或密码不正确。", 401);
      account = { id: stored.id, username: stored.username };
    }
    const token = randomBytes(32).toString("base64url");
    await store.startSession(hash(token), account.id, Date.now() + sessionSeconds * 1000);
    if (previous) await store.endSession(previous);
    res.setHeader("Set-Cookie", cookie(token, sessionSeconds));
    sendJson(res, register ? 201 : 200, { account });
    return;
  }
  if (path.startsWith("/api/auth/")) throw new HttpError("找不到该账号接口。", 404);
  const account = previous ? await store.session(previous) : null;
  const expected = req.headers["x-ielts-account"];
  if (!account || (expected && expected !== account.id)) throw new HttpError("请先登录再继续学习。", 401);
  return account;
}
