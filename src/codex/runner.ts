import { spawn } from "child_process";
import fs from "fs";
import path from "path";

import {
  CODEX_BIN,
  CODEX_CMD_ALLOW,
  CODEX_CMD_BLOCK,
  CODEX_CMD_CONFIRM,
  CODEX_TIMEOUT_MS,
  DEFAULT_LANGUAGE,
} from "../config.js";
import { AgentRequest, AgentResponse } from "../types.js";
import { logger } from "../logger.js";
import {
  clearConversationCliSessionId,
  getCliSessionIdForWorkspace,
  getConversationCliSessionId,
  setCliSessionIdForWorkspace,
  setConversationCliSessionId,
  setWorkspaceForCliSessionId,
} from "../store/db.js";

export type CodexRunMode = "proposal" | "execute";

export async function runCodex(
  request: AgentRequest,
  workspaceDir: string,
  mode: CodexRunMode,
  options?: { allowAutoExecute?: boolean },
): Promise<AgentResponse> {
  return runCodexCli(request, workspaceDir, mode, options);
}

export function resetCodexCliSession(conversationId: string): void {
  clearConversationCliSessionId(conversationId);
}

async function runCodexCli(
  request: AgentRequest,
  workspaceDir: string,
  mode: CodexRunMode,
  options?: { allowAutoExecute?: boolean },
): Promise<AgentResponse> {
  fs.mkdirSync(workspaceDir, { recursive: true });

  const outputFile = path.join(workspaceDir, ".codex_last_message.txt");
  try {
    fs.unlinkSync(outputFile);
  } catch {
    // Ignore missing file.
  }

  const args: string[] = [
    "exec",
    "--skip-git-repo-check",
    "-C",
    workspaceDir,
    "--color",
    "never",
    "-o",
    outputFile,
  ];
  const resumeSessionId =
    getConversationCliSessionId(request.conversationId) ||
    getCliSessionIdForWorkspace(workspaceDir);
  if (request.modelOverride) {
    args.push("-m", request.modelOverride);
  }
  if (mode === "proposal") {
    args.push("-s", "read-only");
  } else {
    args.push("--full-auto");
  }
  if (resumeSessionId) {
    args.push("resume", resumeSessionId);
  }

  const prompt = buildPrompt(request, mode);
  logger.info({ backend: "cli", mode, args }, "Codex CLI args");
  const rawOutput = await runProcess(args, prompt, workspaceDir);
  const output = readOutputFile(outputFile) || rawOutput;
  logger.info({ backend: "cli", mode, output }, "Codex output");
  const parsedSessionId = extractCliSessionId(rawOutput);
  const effectiveSessionId = parsedSessionId || resumeSessionId;
  if (effectiveSessionId) {
    setConversationCliSessionId(request.conversationId, effectiveSessionId);
    setCliSessionIdForWorkspace(workspaceDir, effectiveSessionId);
    setWorkspaceForCliSessionId(effectiveSessionId, workspaceDir);
  }

  if (mode === "execute") {
    return { type: "message", text: output.trim() || "(empty response)" };
  }

  const parsed = parseProposal(output);
  if (!parsed) {
    return { type: "message", text: output.trim() || "(empty response)", parsed: false };
  }

  const policy = evaluateCommandPolicy(parsed.commands);
  if (policy.blocked) {
    return {
      type: "message",
      text: `命令被策略禁止：${policy.blockedCommands.join("; ")}`,
      parsed: true,
      blocked: true,
    };
  }

  const needsApproval = computeApprovalDecision(parsed, policy);
  if (!needsApproval) {
    if (policy.autoExecute && options?.allowAutoExecute !== false) {
      const execResponse = await runCodexCli(request, workspaceDir, "execute", options);
      if (execResponse.type === "message") {
        return { ...execResponse, autoExecuted: true, parsed: true };
      }
      return execResponse;
    }
    return { type: "message", text: parsed.response || "(empty response)", parsed: true };
  }

  return {
    type: "needs_approval",
    text: parsed.response || "我准备执行更改，需要你的确认。",
    approvalId: parsed.approvalId,
    summary: parsed.summary || "准备执行更改",
  };
}

function extractCliSessionId(output: string): string | null {
  const match = output.match(/session id:\s*([a-z0-9-]+)/i);
  if (match?.[1]) return match[1];
  const altMatch = output.match(/session_id:\s*([a-z0-9-]+)/i);
  return altMatch?.[1] || null;
}

function buildPrompt(request: AgentRequest, mode: CodexRunMode): string {
  const languageHint = DEFAULT_LANGUAGE === "zh" ? "请用中文回复。" : "Reply in English.";
  const context = request.contextMessages
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n");
  const policyHint = buildPolicyHint();

  if (mode === "proposal") {
    return `SYSTEM:\nYou are Codex CLI running inside a chat bot. ${languageHint}\n\n` +
      `Rules:\n` +
      `- Do NOT run commands or modify files yet.\n` +
      `- First decide whether execution (commands or file edits) is needed.\n` +
      policyHint +
      `- Output strictly in this format:\n` +
      `NEEDS_APPROVAL: yes|no\n` +
      `SUMMARY: <short summary>\n` +
      `COMMANDS:\n- <command or none>\n` +
      `FILES:\n- <file or none>\n` +
      `RESPONSE:\n<user-facing response>\n\n` +
      `CONTEXT:\n${context || "(empty)"}\n\n` +
      `USER:\n${request.userText}\n`;
  }

  return `SYSTEM:\nYou are Codex CLI. ${languageHint}\n` +
    `You are now approved to execute commands and modify files as needed.\n` +
    `Provide the final response only (no approval format).\n\n` +
    `CONTEXT:\n${context || "(empty)"}\n\n` +
    `USER:\n${request.userText}\n`;
}

type ProposalResult = {
  needsApproval: boolean;
  summary: string;
  response: string;
  approvalId: string;
  commands: string[];
  files: string[];
};

type CommandPolicy = {
  blocked: boolean;
  blockedCommands: string[];
  needsApproval: boolean;
  autoExecute: boolean;
};

function parseProposal(output: string): ProposalResult | null {
  const needsMatch = output.match(/NEEDS_APPROVAL\s*[:：]\s*(yes|no)/i);
  if (!needsMatch) return null;

  const needsApproval = needsMatch[1].toLowerCase() === "yes";
  const summary = extractSection(output, "SUMMARY");
  const commands = parseListSection(extractSection(output, "COMMANDS"));
  const files = parseListSection(extractSection(output, "FILES"));
  const response = extractSection(output, "RESPONSE");

  return {
    needsApproval,
    summary: summary || "",
    response: response || "",
    approvalId: `appr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    commands,
    files,
  };
}

function extractSection(text: string, label: string): string {
  const marker = new RegExp(`${label}\\s*[:：]`, "i");
  const match = text.match(marker);
  if (!match || match.index == null) return "";
  const idx = match.index;
  const after = text.slice(idx + match[0].length);
  const nextMarker = after.search(/\n[A-Z_]+\s*[:：]\s*/);
  const section = nextMarker === -1 ? after : after.slice(0, nextMarker);
  return section.trim();
}

function parseListSection(section: string): string[] {
  if (!section) return [];
  const lines = section.split(/\r?\n/);
  const items = lines
    .map((line) => line.replace(/^\s*-\s*/, "").trim())
    .filter(Boolean)
    .filter((item) => item.toLowerCase() !== "none");
  return items;
}

function buildPolicyHint(): string {
  const lines: string[] = [];
  if (CODEX_CMD_BLOCK.length > 0) {
    lines.push(`- Forbidden commands: ${CODEX_CMD_BLOCK.join(", ")} (do not propose).\n`);
  }
  if (CODEX_CMD_CONFIRM.length > 0) {
    lines.push(`- Commands requiring confirmation: ${CODEX_CMD_CONFIRM.join(", ")}.\n`);
  }
  if (CODEX_CMD_ALLOW.length > 0) {
    lines.push(`- Commands allowed without confirmation: ${CODEX_CMD_ALLOW.join(", ")}.\n`);
  }
  lines.push("- If you plan to modify files, set NEEDS_APPROVAL to yes.\n");
  lines.push("- If commands do not require confirmation and no file edits are needed, set NEEDS_APPROVAL to no.\n");
  if (lines.length === 0) return "";
  return lines.join("");
}

function computeApprovalDecision(parsed: ProposalResult, policy: CommandPolicy): boolean {
  if (policy.blocked) return true;
  if (policy.autoExecute) return false;
  return parsed.needsApproval || policy.needsApproval || parsed.files.length > 0;
}

function evaluateCommandPolicy(commands: string[]): CommandPolicy {
  const blockedCommands: string[] = [];
  let needsApproval = false;

  const blockPatterns = compilePatterns(CODEX_CMD_BLOCK);
  const confirmPatterns = compilePatterns(CODEX_CMD_CONFIRM);
  const allowPatterns = compilePatterns(CODEX_CMD_ALLOW);

  const matchBlock = (cmd: string) => matchesAny(cmd, blockPatterns);
  const matchConfirm = (cmd: string) => matchesAny(cmd, confirmPatterns);
  const matchAllow = (cmd: string) => matchesAny(cmd, allowPatterns);

  for (const cmd of commands) {
    if (matchBlock(cmd)) {
      blockedCommands.push(cmd);
    }
    if (matchConfirm(cmd)) {
      needsApproval = true;
    }
  }

  const allowAll =
    allowPatterns.length > 0 &&
    commands.length > 0 &&
    commands.every((cmd) => matchAllow(cmd));

  return {
    blocked: blockedCommands.length > 0,
    blockedCommands,
    needsApproval,
    autoExecute: allowAll && !needsApproval,
  };
}

type CompiledPattern = {
  raw: string;
  regex: RegExp;
};

function compilePatterns(list: string[]): CompiledPattern[] {
  return list
    .map((raw) => raw.trim())
    .filter(Boolean)
    .map((raw) => ({ raw, regex: compilePattern(raw) }))
    .filter((item) => Boolean(item.regex)) as CompiledPattern[];
}

function compilePattern(raw: string): RegExp {
  if (raw.startsWith("/") && raw.lastIndexOf("/") > 0) {
    const lastSlash = raw.lastIndexOf("/");
    const pattern = raw.slice(1, lastSlash);
    const flags = raw.slice(lastSlash + 1);
    if (flags !== "" && !/^[gimsuy]+$/.test(flags)) {
      return new RegExp(escapeRegex(raw), "i");
    }
    try {
      return new RegExp(pattern, flags || "i");
    } catch {
      return new RegExp(escapeRegex(raw), "i");
    }
  }
  return new RegExp(`\\b${escapeRegex(raw)}\\b`, "i");
}

function matchesAny(command: string, patterns: CompiledPattern[]): boolean {
  if (patterns.length === 0) return false;
  return patterns.some((pattern) => pattern.regex.test(command));
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readOutputFile(filePath: string): string {
  try {
    if (!fs.existsSync(filePath)) return "";
    return fs.readFileSync(filePath, "utf-8").trim();
  } catch {
    return "";
  }
}

async function runProcess(args: string[], input: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(CODEX_BIN, args, { cwd, env: process.env });
    let stdout = "";
    let stderr = "";
    let finished = false;

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      proc.kill("SIGKILL");
      reject(new Error(`Codex timed out after ${CODEX_TIMEOUT_MS}ms`));
    }, CODEX_TIMEOUT_MS);

    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    proc.on("error", (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(err);
    });

    proc.on("close", (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (code !== 0 && stderr) {
        logger.warn({ code, stderr }, "Codex process exited with error");
      }
      resolve([stdout, stderr].filter(Boolean).join("\n").trim());
    });

    proc.stdin.write(input);
    proc.stdin.end();
  });
}
