import { spawn } from "child_process";
import fs from "fs";
import path from "path";

import { Codex } from "@openai/codex-sdk";

import {
  CODEX_BACKEND,
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
  clearConversationThreadId,
  clearConversationCliSessionId,
  getCliSessionIdForWorkspace,
  getConversationCliSessionId,
  getConversationThreadId,
  getThreadIdForWorkspace,
  setCliSessionIdForWorkspace,
  setConversationCliSessionId,
  setConversationThreadId,
  setWorkspaceForCliSessionId,
  setWorkspaceForThreadId,
  setThreadIdForWorkspace,
} from "../store/db.js";
import { loadCodexSdkConfig } from "./sdk_config.js";

export type CodexRunMode = "proposal" | "execute";

type CodexThread = {
  run: (prompt: string) => Promise<{ messages?: Array<{ content?: unknown }> }>;
  id?: string;
  threadId?: string;
};

const sdkThreads = new Map<string, CodexThread>();
let sdkClient: Codex | null = null;

export async function runCodex(
  request: AgentRequest,
  workspaceDir: string,
  mode: CodexRunMode,
): Promise<AgentResponse> {
  const backend = request.backendOverride || CODEX_BACKEND;
  if (backend === "sdk") {
    return runCodexSdk(request, mode, workspaceDir);
  }
  return runCodexCli(request, workspaceDir, mode);
}

export function resetCodexThread(conversationId: string): void {
  sdkThreads.delete(conversationId);
  clearConversationThreadId(conversationId);
}

export function resetCodexCliSession(conversationId: string): void {
  clearConversationCliSessionId(conversationId);
}

async function runCodexSdk(
  request: AgentRequest,
  mode: CodexRunMode,
  workspaceDir?: string,
): Promise<AgentResponse> {
  const thread = await getOrCreateThread(request.conversationId, workspaceDir);
  const prompt = buildPrompt(request, mode);
  const result = request.modelOverride
    ? await (thread as unknown as { run: (p: string, o?: { model?: string }) => Promise<any> }).run(
        prompt,
        { model: request.modelOverride },
      )
    : await thread.run(prompt);
  const output = extractSdkOutput(result);
  if (!output) {
    logger.warn({ backend: "sdk", mode, result }, "Codex SDK output empty");
  } else {
    logger.info({ backend: "sdk", mode, output }, "Codex output");
  }

  if (mode === "execute") {
    return { type: "message", text: output.trim() || "(empty response)" };
  }

  const parsed = parseProposal(output);
  if (!parsed) {
    return { type: "message", text: output.trim() || "(empty response)" };
  }

  const policy = evaluateCommandPolicy(parsed.commands);
  if (policy.blocked) {
    return {
      type: "message",
      text: `命令被策略禁止：${policy.blockedCommands.join("; ")}`,
    };
  }

  const needsApproval = computeApprovalDecision(parsed, policy);
  if (!needsApproval) {
    if (policy.autoExecute) {
      return runCodexSdk(request, "execute", workspaceDir);
    }
    return { type: "message", text: parsed.response || "(empty response)" };
  }

  return {
    type: "needs_approval",
    text: parsed.response || "我准备执行更改，需要你的确认。",
    approvalId: parsed.approvalId,
    summary: parsed.summary || "准备执行更改",
  };
}

function getSdkClient(): Codex {
  if (sdkClient) return sdkClient;
  const resolved = loadCodexSdkConfig();
  const options: Record<string, string> = {};
  if (resolved.apiKey) options.apiKey = resolved.apiKey;
  if (resolved.baseURL) options.baseURL = resolved.baseURL;
  sdkClient = new (Codex as unknown as new (opts?: Record<string, string>) => Codex)(
    Object.keys(options).length ? options : undefined,
  );
  return sdkClient;
}

async function getOrCreateThread(
  conversationId: string,
  workspaceDir?: string,
): Promise<CodexThread> {
  const cached = sdkThreads.get(conversationId);
  if (cached) return cached;

  const codex = getSdkClient();
  const storedId = getConversationThreadId(conversationId);
  const workspaceId = workspaceDir ? getThreadIdForWorkspace(workspaceDir) : null;
  let thread: CodexThread | null = null;

  if (storedId || workspaceId) {
    const resume = (codex as unknown as { resumeThread?: (id: string) => Promise<CodexThread> })
      .resumeThread;
    const getThread = (codex as unknown as { getThread?: (id: string) => Promise<CodexThread> })
      .getThread;
    const getter = resume || getThread;
    if (getter) {
      try {
        const id = storedId || workspaceId || "";
        thread = await getter.call(codex, id);
      } catch (err) {
        logger.warn({ err }, "Failed to resume Codex thread; starting new thread");
      }
    }
  }

  if (!thread) {
    thread = (await (codex as unknown as { startThread: () => Promise<CodexThread> }).startThread()) as
      CodexThread;
  }

  const id = thread.id || thread.threadId;
  if (id) {
    setConversationThreadId(conversationId, id);
    if (workspaceDir) {
      setThreadIdForWorkspace(workspaceDir, id);
      setWorkspaceForThreadId(id, workspaceDir);
    }
  }

  sdkThreads.set(conversationId, thread);
  return thread;
}

function extractSdkOutput(result: unknown): string {
  const seen = new Set<unknown>();

  const extractContentText = (content: unknown): string => {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((part) => {
          if (typeof part === "string") return part;
          if (part && typeof part === "object" && "text" in part) {
            const text = (part as { text?: unknown }).text;
            return typeof text === "string" ? text : "";
          }
          if (part && typeof part === "object" && "value" in part) {
            const value = (part as { value?: unknown }).value;
            return typeof value === "string" ? value : "";
          }
          return "";
        })
        .join("")
        .trim();
    }
    return "";
  };

  const extractFromMessages = (messages: unknown): string => {
    if (!Array.isArray(messages)) return "";
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const msg = messages[i] as Record<string, unknown> | null;
      if (!msg || typeof msg !== "object") continue;
      const role = typeof msg.role === "string" ? msg.role : "";
      const type = typeof msg.type === "string" ? msg.type : "";
      if (role && role !== "assistant" && type !== "message") continue;
      const content = extractContentText(msg.content);
      if (content) return content;
      const text = extractContentText(msg.text);
      if (text) return text;
    }
    return "";
  };

  const extractFromOutput = (output: unknown): string => {
    if (!Array.isArray(output)) return "";
    for (let i = output.length - 1; i >= 0; i -= 1) {
      const item = output[i] as Record<string, unknown> | null;
      if (!item || typeof item !== "object") continue;
      const type = typeof item.type === "string" ? item.type : "";
      const role = typeof item.role === "string" ? item.role : "";
      if (type && type !== "message" && role && role !== "assistant") continue;
      const content = extractContentText(item.content);
      if (content) return content;
      const text = extractContentText(item.text);
      if (text) return text;
    }
    return "";
  };

  const deepExtract = (value: unknown, depth: number): string => {
    if (value == null || depth > 6) return "";
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (Array.isArray(value)) {
      const fromArray = extractFromMessages(value) || extractFromOutput(value);
      if (fromArray) return fromArray;
      for (let i = value.length - 1; i >= 0; i -= 1) {
        const found = deepExtract(value[i], depth + 1);
        if (found) return found;
      }
      return "";
    }
    if (typeof value === "object") {
      if (seen.has(value)) return "";
      seen.add(value);
      const obj = value as Record<string, unknown>;

      const directKeys = ["output_text", "outputText", "text", "final", "message"];
      for (const key of directKeys) {
        const found = deepExtract(obj[key], depth + 1);
        if (found) return found;
      }

      const outputLike = extractFromOutput(obj.output) || extractFromMessages(obj.messages);
      if (outputLike) return outputLike;

      const contentLike = extractContentText(obj.content);
      if (contentLike) return contentLike;

      const nestedKeys = ["response", "result", "data"];
      for (const key of nestedKeys) {
        const found = deepExtract(obj[key], depth + 1);
        if (found) return found;
      }

      for (const key of Object.keys(obj)) {
        const found = deepExtract(obj[key], depth + 1);
        if (found) return found;
      }
    }
    return "";
  };

  return deepExtract(result, 0).trim();
}

async function runCodexCli(
  request: AgentRequest,
  workspaceDir: string,
  mode: CodexRunMode,
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
    return { type: "message", text: output.trim() || "(empty response)" };
  }

  const policy = evaluateCommandPolicy(parsed.commands);
  if (policy.blocked) {
    return {
      type: "message",
      text: `命令被策略禁止：${policy.blockedCommands.join("; ")}`,
    };
  }

  const needsApproval = computeApprovalDecision(parsed, policy);
  if (!needsApproval) {
    if (policy.autoExecute) {
      return runCodexCli(request, workspaceDir, "execute");
    }
    return { type: "message", text: parsed.response || "(empty response)" };
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
