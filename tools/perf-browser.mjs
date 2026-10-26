// Browser-side latency probe for PERF-01, driven over the Chrome DevTools Protocol.
// Usage: node tools/perf-browser.mjs [baseUrl] [label]
// Prints first-load marks, per-interaction wall time and the slowest requests.
// Pass a throttle profile as PERF_THROTTLE=4g to emulate a 10 Mbps / 80 ms link.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = (process.argv[2] ?? "http://127.0.0.1:4181").replace(/\/$/, "");
const label = process.argv[3] ?? "run";
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const port = 9400 + Math.floor(Math.random() * 300);
const profile = mkdtempSync(join(tmpdir(), "ielts-perf-chrome-"));

const child = spawn(chrome, [
  "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--hide-scrollbars",
  "--window-size=1440,900", "about:blank",
], { stdio: "ignore" });

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function findTarget() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((item) => item.type === "page");
      if (page) return page;
    } catch { /* browser still starting */ }
    await wait(100);
  }
  throw new Error("Chrome did not start");
}

const target = await findTarget();
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
let nextId = 1;
const pending = new Map();
const consoleErrors = [];
socket.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id) {
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message));
    else entry.resolve(message.result);
    return;
  }
  if (message.method === "Runtime.exceptionThrown") consoleErrors.push(message.params.exceptionDetails?.text ?? "exception");
  if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
    consoleErrors.push(message.params.args.map((arg) => arg.value ?? arg.description ?? "").join(" "));
  }
};
function send(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text + " " + (result.exceptionDetails.exception?.description ?? ""));
  return result.result.value;
}
async function waitFor(selector, timeout = 30000) {
  const started = performance.now();
  while (performance.now() - started < timeout) {
    if (await evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`)) return performance.now() - started;
    await wait(25);
  }
  throw new Error(`timed out waiting for ${selector}`);
}
// After Page.reload the old document still matches selectors for a few frames; wait for the new one.
async function waitForReloaded(selector, timeout = 60000) {
  const started = performance.now();
  while (performance.now() - started < timeout) {
    const ready = await evaluate(`(() => {
      const entry = performance.getEntriesByType("navigation")[0];
      return entry?.type === "reload" && Boolean(document.querySelector(${JSON.stringify(selector)}));
    })()`);
    if (ready) return performance.now() - started;
    await wait(25);
  }
  throw new Error(`timed out waiting for reloaded ${selector}`);
}
const fmt = (value) => `${value.toFixed(0)}ms`;

await send("Page.enable");
await send("Runtime.enable");
await send("Network.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
if (process.env.PERF_THROTTLE === "4g") {
  await send("Network.emulateNetworkConditions", { offline: false, latency: 80, downloadThroughput: 1_250_000, uploadThroughput: 625_000, connectionType: "cellular4g" });
}
await send("Page.addScriptToEvaluateOnNewDocument", { source: `
  window.__perfMarks = [];
  const mark = (name) => window.__perfMarks.push({ name, t: Math.round(performance.now()) });
  mark("script-start");
  addEventListener("DOMContentLoaded", () => mark("domcontentloaded"));
  addEventListener("load", () => mark("load"));
  const wanted = [["auth-skeleton", ".loading-shell"], ["app-frame", ".app-frame"], ["page-content", ".page-content"]];
  const seen = new Set();
  const check = () => { for (const [name, selector] of wanted) if (!seen.has(name) && document.querySelector(selector)) { seen.add(name); mark(name); } };
  const timer = setInterval(() => { check(); if (seen.size === wanted.length) clearInterval(timer); }, 20);
  check();
` });

const interactions = [];
async function step(name, action, readySelector, timeout = 30000) {
  const started = performance.now();
  await action();
  const waited = await waitFor(readySelector, timeout);
  interactions.push({ name, total: performance.now() - started, waited });
}

await send("Page.navigate", { url: base + "/" });
await waitFor(".app-frame", 60000);
await wait(300);
const marks = await evaluate("window.__perfMarks");

await step("nav: listening library", () => evaluate(`document.querySelector('[aria-label="听力练习"]')?.click()`), ".library-row");
await step("open preparation", () => evaluate(`document.querySelector(".library-row button")?.click()`), ".exam-preparation");
await step("preflight ready (audio metadata)", async () => {}, ".exam-start-button:not([disabled])", 40000);
await step("start practice -> workspace", () => evaluate(`document.querySelector(".exam-start-button")?.click()`), ".practice-host .exam-shell", 40000);
await step("switch question (palette)", () => evaluate(`document.querySelectorAll(".practice-host .exam-cell")[1]?.click()`), ".practice-host .exam-palette-grid .exam-cell:nth-child(2).is-current", 10000);

const answered = await evaluate(`(() => {
  const input = document.querySelector(".practice-host input[type=radio]") || document.querySelector(".practice-host input[data-blank]");
  if (!input) return false;
  if (input.type === "radio") input.checked = true;
  else input.value = "perf answer";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
})()`);
await wait(1200);
const saveRequests = await evaluate(`performance.getEntriesByType("resource").filter((entry) => entry.name.includes("/draft")).map((entry) => ({ name: entry.name.split("/api/")[1], duration: Math.round(entry.duration), size: entry.transferSize }))`);

if (process.env.PERF_RESUME === "1") {
  const reloadStarted = performance.now();
  await send("Page.reload", { ignoreCache: true });
  const reloadWaited = await waitForReloaded(".practice-host .exam-shell");
  interactions.push({ name: "reload -> restored draft", total: performance.now() - reloadStarted, waited: reloadWaited });
  await wait(300);
  const restore = await evaluate(`(() => ({
    checked: document.querySelectorAll(".practice-host input[type=radio]:checked").length,
    filledBlanks: [...document.querySelectorAll(".practice-host input[data-blank]")].filter((input) => input.value).length,
    progress: document.querySelector("[data-exam-progress]")?.textContent ?? "",
  }))()`);
  console.log("restored draft:", JSON.stringify(restore));
}

await step("open AI tutor", async () => {
  await evaluate(`document.querySelector(".exam-tools-menu summary")?.click()`);
  await evaluate(`[...document.querySelectorAll(".exam-tools-menu [role=menuitem]")].find((node) => node.textContent.includes("AI tutor"))?.click()`);
}, ".coach-drawer");
await wait(600);
const coachRequests = await evaluate(`performance.getEntriesByType("resource").filter((entry) => entry.name.includes("/api/coach")).map((entry) => ({ name: entry.name.split("/api/")[1], duration: Math.round(entry.duration), size: entry.transferSize }))`);
await evaluate(`document.querySelector('[aria-label="关闭导师"]')?.click()`);

await step("submit -> result", async () => {
  await evaluate(`document.querySelector(".practice-host .exam-submit")?.click()`);
  await waitFor("[data-submit-dialog][open]");
  await evaluate(`document.querySelector("[data-confirm-submit]")?.click()`);
}, ".exam-shell.has-result", 60000);
await wait(1500);

const resources = await evaluate(`performance.getEntriesByType("resource").map((entry) => ({
  name: entry.name.replace(location.origin, ""),
  duration: Math.round(entry.duration),
  size: entry.transferSize,
  start: Math.round(entry.startTime),
  type: entry.initiatorType,
})).sort((a, b) => b.duration - a.duration)`);
const navigation = await evaluate(`(() => { const entry = performance.getEntriesByType("navigation")[0]; return { ttfb: Math.round(entry.responseStart), domContentLoaded: Math.round(entry.domContentLoadedEventEnd), load: Math.round(entry.loadEventEnd), transfer: entry.transferSize }; })()`);

console.log(`\n=== ${label} (${base}${process.env.PERF_THROTTLE ? ", throttle=" + process.env.PERF_THROTTLE : ""}) ===`);
console.log("first load:", JSON.stringify({ navigation, marks }));
console.log("interactions:");
for (const item of interactions) console.log(`  ${item.name}\t${fmt(item.total)}`);
console.log("draft saves:", JSON.stringify(saveRequests));
console.log("coach history:", JSON.stringify(coachRequests));
console.log("slowest requests:");
for (const entry of resources.slice(0, 12)) console.log(`  ${entry.duration}ms\t${(entry.size / 1024).toFixed(0)}KB\t${entry.name}`);
console.log("bootstrap payloads:", JSON.stringify(resources.filter((entry) => entry.name.includes("/api/bootstrap")).map((entry) => ({ size: entry.size, duration: entry.duration, start: entry.start }))));
if (consoleErrors.length) console.log("console errors:", consoleErrors.slice(0, 5));
if (!answered) console.log("warning: no answer input found");
console.log("");

socket.close();
child.kill("SIGKILL");
