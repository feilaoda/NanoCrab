import "./env.js";
import os from "os";
import path from "path";

export const PROJECT_ROOT = process.cwd();
export const DATA_DIR = path.join(PROJECT_ROOT, "data");
export const STORE_DIR = path.join(PROJECT_ROOT, "store");
export const LOG_DIR = path.join(PROJECT_ROOT, "logs");
export const RESTART_LOG_PATH = path.join(LOG_DIR, "restart.log");
export const PLUGINS_DIR = path.join(DATA_DIR, "plugins");
export const PLUGIN_REGISTRY_PATH = path.join(STORE_DIR, "plugins.json");

export const LOG_LEVEL = process.env.LOG_LEVEL || "info";
const rawRunner = (process.env.NANOCRAB_RUNNER || "").trim().toLowerCase();
export const RUNNER_ORIGIN = rawRunner || "local";

export const FEISHU_API_BASE = (process.env.FEISHU_API_BASE || "https://open.feishu.cn")
  .replace(/\/$/, "");
export const FEISHU_APP_ID = process.env.FEISHU_APP_ID || "";
export const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || "";
export const FEISHU_BOT_NAME = process.env.FEISHU_BOT_NAME || "";
export const FEISHU_BOT_OPEN_ID = process.env.FEISHU_BOT_OPEN_ID || "";
export const FEISHU_ENCRYPT_KEY = process.env.FEISHU_ENCRYPT_KEY || "";
export const FEISHU_SDK_LOG_LEVEL = process.env.FEISHU_SDK_LOG_LEVEL || "";
export const FEISHU_RTM_ENABLED = !["false", "0", "no"].includes(
  (process.env.FEISHU_RTM_ENABLED || "true").toLowerCase(),
);
export const FEISHU_RTM_CONNECT_PATH =
  process.env.FEISHU_RTM_CONNECT_PATH || "/open-apis/rtm/v1/connect";
export const FEISHU_RTM_CONNECT_URL = process.env.FEISHU_RTM_CONNECT_URL || "";
export const RESTART_CMD = process.env.RESTART_CMD || "npm run dev";

const rawSafeDirs = process.env.SAFE_DIRS;
export const SAFE_DIRS = normalizeDirList(
  rawSafeDirs === undefined ? PROJECT_ROOT : rawSafeDirs,
);

const rawCmdBlock = process.env.CODEX_CMD_BLOCK;
const rawCmdConfirm = process.env.CODEX_CMD_CONFIRM;
const rawCmdAllow = process.env.CODEX_CMD_ALLOW;
export const CODEX_CMD_BLOCK = rawCmdBlock === undefined
  ? ["mkfs", "shutdown", "dd", "reboot", "poweroff", "halt"]
  : parseList(rawCmdBlock);
export const CODEX_CMD_CONFIRM = rawCmdConfirm === undefined
  ? ["rm", "dd"]
  : parseList(rawCmdConfirm);
export const CODEX_CMD_ALLOW = parseList(rawCmdAllow || "");

export const CODEX_BACKEND = "cli";
export const CODEX_BIN = process.env.CODEX_BIN || "codex";
export const CODEX_TIMEOUT_MS = Number(process.env.CODEX_TIMEOUT_MS || 300000);
export const MAX_CONTEXT_MESSAGES = Number(process.env.MAX_CONTEXT_MESSAGES || 20);

export const MARKET_ALPHA_VANTAGE_API_KEY = process.env.MARKET_ALPHA_VANTAGE_API_KEY || "";
export const MARKET_REQUEST_GAP_MS = Number(process.env.MARKET_REQUEST_GAP_MS || 15000);
export const MARKET_CACHE_TTL_MS = Number(process.env.MARKET_CACHE_TTL_MS || 55000);

export const DEFAULT_LANGUAGE = process.env.DEFAULT_LANGUAGE || "zh";
export const HTTP_API_ENABLED = !["false", "0", "no"].includes(
  (process.env.HTTP_API_ENABLED || "true").toLowerCase(),
);
export const HTTP_API_HOST = process.env.HTTP_API_HOST || "127.0.0.1";
export const HTTP_API_PORT = Number(process.env.HTTP_API_PORT || 8787);
export const HTTP_API_TOKEN = process.env.HTTP_API_TOKEN || "";

function parseList(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeDirList(raw: string): string[] {
  const items = parseList(raw);
  if (items.length === 0) {
    return [];
  }
  return items.map((dir) => path.resolve(expandHomeDir(dir)));
}

function expandHomeDir(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}
