import "./env.js";
import os from "os";
import path from "path";

export const PROJECT_ROOT = process.cwd();
export const DATA_DIR = path.join(PROJECT_ROOT, "data");
export const STORE_DIR = path.join(PROJECT_ROOT, "store");

export const LOG_LEVEL = process.env.LOG_LEVEL || "info";

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

const rawSafeDirs = process.env.SAFE_DIRS;
export const SAFE_DIRS = normalizeDirList(
  rawSafeDirs === undefined ? PROJECT_ROOT : rawSafeDirs,
);

const rawCmdBlock = process.env.CODEX_CMD_BLOCK;
const rawCmdConfirm = process.env.CODEX_CMD_CONFIRM;
const rawCmdAllow = process.env.CODEX_CMD_ALLOW;
export const CODEX_CMD_BLOCK = parseList(rawCmdBlock || "");
export const CODEX_CMD_CONFIRM = rawCmdConfirm === undefined
  ? ["rm", "dd"]
  : parseList(rawCmdConfirm);
export const CODEX_CMD_ALLOW = parseList(rawCmdAllow || "");

export const CODEX_BACKEND = (process.env.CODEX_BACKEND || "cli").toLowerCase();
export const CODEX_SDK_API_KEY = process.env.CODEX_SDK_API_KEY || "";
export const CODEX_SDK_BASE_URL = process.env.CODEX_SDK_BASE_URL || "";
export const CODEX_BIN = process.env.CODEX_BIN || "codex";
export const CODEX_TIMEOUT_MS = Number(process.env.CODEX_TIMEOUT_MS || 300000);
export const MAX_CONTEXT_MESSAGES = Number(process.env.MAX_CONTEXT_MESSAGES || 20);

export const DEFAULT_LANGUAGE = process.env.DEFAULT_LANGUAGE || "zh";

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
