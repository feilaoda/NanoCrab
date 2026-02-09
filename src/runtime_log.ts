import fs from "fs";
import path from "path";

import { LOG_DIR, RESTART_LOG_PATH, RUNNER_ORIGIN } from "./config.js";

function appendLine(line: string): void {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(RESTART_LOG_PATH, `${line}\n`);
  } catch {
    // best-effort logging
  }
}

export function logRuntimeStart(pid: number, startedAt: string): void {
  appendLine(`[${startedAt}] start pid=${pid} runner=${RUNNER_ORIGIN}`);
}

export function logRestartRequest(chatId: string, pid: number): void {
  const now = new Date().toISOString();
  appendLine(`[${now}] restart requested chatId=${chatId} pid=${pid}`);
}

function appendConversationLine(line: string): void {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    const filePath = path.join(LOG_DIR, `conversation-${date}.log`);
    fs.appendFileSync(filePath, `${line}\n`);
  } catch {
    // best-effort logging
  }
}

export function logConversationEvent(event: Record<string, unknown>): void {
  const ts = new Date().toISOString();
  const entry = { ts, ...event };
  appendConversationLine(JSON.stringify(entry));
}
