import { spawn } from "child_process";

const WATCHDOG_CMD = (process.env.WATCHDOG_CMD || "npm run dev").trim();
const WATCHDOG_BACKOFF_MS = parsePositiveInt(process.env.WATCHDOG_BACKOFF_MS, 1000);
const WATCHDOG_MAX_BACKOFF_MS = parsePositiveInt(process.env.WATCHDOG_MAX_BACKOFF_MS, 30000);
const WATCHDOG_STABLE_MS = parsePositiveInt(process.env.WATCHDOG_STABLE_MS, 15000);

let child = null;
let stopping = false;
let crashCount = 0;

function parsePositiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function log(message) {
  const ts = new Date().toISOString();
  console.log(`[watchdog] ${ts} ${message}`);
}

function scheduleRestart(exitInfo, ranMs) {
  if (ranMs >= WATCHDOG_STABLE_MS) {
    crashCount = 0;
  } else {
    crashCount += 1;
  }
  const factor = Math.max(1, 2 ** Math.max(0, crashCount - 1));
  const delay = Math.min(WATCHDOG_BACKOFF_MS * factor, WATCHDOG_MAX_BACKOFF_MS);
  log(`子进程退出(${exitInfo})，${delay}ms 后重启。`);
  setTimeout(() => {
    if (!stopping) startChild();
  }, delay);
}

function startChild() {
  if (stopping) return;
  const startedAt = Date.now();
  log(`启动子进程: ${WATCHDOG_CMD}`);
  child = spawn(WATCHDOG_CMD, {
    stdio: "inherit",
    shell: true,
    env: process.env,
  });

  child.on("exit", (code, signal) => {
    const ranMs = Date.now() - startedAt;
    const exitInfo = `code=${code ?? "null"}, signal=${signal ?? "null"}`;
    child = null;
    if (stopping) {
      log(`子进程已退出(${exitInfo})，watchdog 停止。`);
      process.exit(0);
      return;
    }
    scheduleRestart(exitInfo, ranMs);
  });

  child.on("error", (err) => {
    const ranMs = Date.now() - startedAt;
    child = null;
    if (stopping) {
      process.exit(0);
      return;
    }
    scheduleRestart(`error=${String(err)}`, ranMs);
  });
}

function stopWatchdog(signal) {
  if (stopping) return;
  stopping = true;
  log(`收到 ${signal}，准备停止 watchdog。`);
  if (!child) {
    process.exit(0);
    return;
  }
  child.kill(signal === "SIGTERM" ? "SIGTERM" : "SIGINT");
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on("SIGINT", () => stopWatchdog("SIGINT"));
process.on("SIGTERM", () => stopWatchdog("SIGTERM"));

if (!WATCHDOG_CMD) {
  console.error("[watchdog] WATCHDOG_CMD 不能为空。");
  process.exit(1);
}

startChild();
