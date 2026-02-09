import os from "os";
import path from "path";
import { spawn } from "child_process";

import { CODEX_BACKEND, DATA_DIR, MAX_CONTEXT_MESSAGES, PROJECT_ROOT, RESTART_CMD, SAFE_DIRS } from "./config.js";
import { resetCodexCliSession, resetCodexThread, runCodex } from "./codex/runner.js";
import { logger } from "./logger.js";
import { PluginManager } from "./plugins/manager.js";
import {
  addSafeDir,
  clearThreadIdForWorkspace,
  clearConversation,
  clearCliSessionIdForWorkspace,
  clearWorkspaceForCliSessionId,
  clearWorkspaceForThreadId,
  createApproval,
  getCliSessionIdForWorkspace,
  getConfirmNext,
  getConversationBackend,
  getConversationCliSessionId,
  getConversationPlugin,
  getConversationThreadId,
  getConversationWorkspace,
  getWriteMode,
  getEffectiveModel,
  getOrCreateConversation,
  getPendingApproval,
  getRecentMessages,
  getSafeDirs,
  getThreadIdForWorkspace,
  getWorkspaceForCliSessionId,
  getWorkspaceForThreadId,
  saveMessage,
  setCliSessionIdForWorkspace,
  setConfirmNext,
  setConversationCliSessionId,
  setConversationWorkspace,
  setConversationPlugin,
  clearConversationPlugin,
  setConversationBackend,
  setConversationModel,
  setConversationThreadId,
  setGlobalModel,
  setThreadIdForWorkspace,
  setWriteMode,
  setRestartNotifyChatId,
  setWorkspaceForCliSessionId,
  setWorkspaceForThreadId,
  updateApprovalStatus,
} from "./store/db.js";
import { AgentRequest, InboundMessage } from "./types.js";

export interface RouterDeps {
  sendMessage: (chatId: string, text: string) => Promise<void>;
}

function normalizeContinue(input: string): string {
  const trimmed = input.trim();
  if (trimmed.toLowerCase() === "/continue") {
    return "继续";
  }
  return input;
}

const CONFIRM_PATTERN = /^(yes|y|确认|好|ok|执行)$/i;
const REJECT_PATTERN = /^(no|n|取消|不要|stop)$/i;
const CONFIRM_COMMANDS = new Set(["/confirm", "/approve"]);
const REJECT_COMMANDS = new Set(["/cancel", "/reject"]);
const PLUGINS = ["codex"] as const;
const CODEX_ONLY_COMMANDS = new Set([
  "cli",
  "backend",
  "dir",
  "mode",
  "model",
  "resume",
  "status",
  "git",
  "confirm",
  "cancel",
  "restart",
]);
let pluginManager: PluginManager | null = null;

function getPluginManager(deps: RouterDeps): PluginManager {
  if (!pluginManager) {
    pluginManager = new PluginManager({ sendMessage: deps.sendMessage });
  } else {
    pluginManager.setHost({ sendMessage: deps.sendMessage });
  }
  return pluginManager;
}

export async function handleInbound(
  msg: InboundMessage,
  deps: RouterDeps,
): Promise<void> {
  const conversationId = getOrCreateConversation(msg.chatId, msg.isGroup);
  const plugin = getConversationPlugin(conversationId);
  const normalizedText = normalizeContinue(msg.text);

  const pending = getPendingApproval(conversationId);
  if (pending) {
    const text = normalizedText.trim();
    const lower = text.toLowerCase();
    if (REJECT_COMMANDS.has(lower) || lower.startsWith("/cancel") || lower.startsWith("/reject")) {
      updateApprovalStatus(pending.id, "rejected");
      await deps.sendMessage(msg.chatId, "已取消执行。可以继续提新的需求。");
      return;
    }
    if (text.startsWith("/") && text.slice(1).trim().toLowerCase() === "exit") {
      updateApprovalStatus(pending.id, "rejected");
      clearConversationPlugin(conversationId);
      await deps.sendMessage(msg.chatId, "已退出当前插件，并取消待确认操作。");
      return;
    }
    if (
      CONFIRM_COMMANDS.has(lower)
      || lower.startsWith("/confirm")
      || lower.startsWith("/approve")
      || CONFIRM_PATTERN.test(text)
    ) {
      updateApprovalStatus(pending.id, "approved");
      await handleApprovalExecution(pending.payload, deps, conversationId, msg.chatId);
      return;
    }
    if (REJECT_PATTERN.test(text)) {
      updateApprovalStatus(pending.id, "rejected");
      await deps.sendMessage(msg.chatId, "已取消执行。可以继续提新的需求。");
      return;
    }
    await deps.sendMessage(msg.chatId, "当前有待确认的执行请求。回复“确认”继续，或“取消”终止。");
    return;
  }

  if (msg.isGroup && !msg.isMentioned) {
    return;
  }

  const command = parseCommand(normalizedText);
  if (command) {
    await handleCommand(command, conversationId, plugin, deps, msg.chatId);
    return;
  }

  if (!plugin) {
    await deps.sendMessage(msg.chatId, "当前未进入任何插件。请输入 /codex 进入 Codex 插件，或 /help 查看指令。");
    return;
  }

  if (plugin !== "codex") {
    const manager = getPluginManager(deps);
    if (!manager.isInstalled(plugin) || !manager.isEnabled(plugin)) {
      await deps.sendMessage(msg.chatId, `当前插件 ${plugin} 未安装或已禁用。`);
      return;
    }
    if (normalizedText.trim()) {
      await deps.sendMessage(msg.chatId, "已收到");
    }
    const workspaceDir = resolveWorkspaceDir(conversationId);
    await manager.handleEvent(
      plugin,
      "message_received",
      { text: normalizedText, timestamp: msg.timestamp },
      {
        conversationId,
        chatId: msg.chatId,
        workspaceDir,
      },
    );
    return;
  }

  const modelOverride = getEffectiveModel(conversationId) || undefined;
  const backendOverride = (getConversationBackend(conversationId) || undefined) as
    | "cli"
    | "sdk"
    | undefined;
  const workspaceDir = resolveWorkspaceDir(conversationId);
  if (!isPathAllowed(workspaceDir)) {
    await deps.sendMessage(
      msg.chatId,
      `当前工作目录不在安全目录内，请先设置允许的目录。\n允许目录：${getAllowedDirs().join(", ") || "(未限制)"}\n使用：/dir set <path>`,
    );
    return;
  }
  if (normalizedText.trim()) {
    await deps.sendMessage(msg.chatId, "已收到");
  }
  const contextMessages = getRecentMessages(conversationId, MAX_CONTEXT_MESSAGES);

  const request: AgentRequest = {
    conversationId,
    userText: normalizedText,
    modelOverride,
    backendOverride,
    contextMessages,
  };

  saveMessage(conversationId, "user", normalizedText, msg.timestamp);

  try {
    const forceExecute = getConfirmNext(conversationId);
    const writeMode = getWriteMode(conversationId);
    if (forceExecute) {
      setConfirmNext(conversationId, false);
      const response = await runCodex(request, workspaceDir, "proposal");
      if (response.type === "needs_approval") {
        const execResponse = await runCodex(request, workspaceDir, "execute");
        if (execResponse.type === "message") {
          saveMessage(conversationId, "assistant", execResponse.text);
          await deps.sendMessage(msg.chatId, execResponse.text || "(无输出)");
        }
        return;
      }
      if (response.text) {
        const inlineApproval = parseInlineApproval(response.text);
        if (inlineApproval) {
          const execResponse = await runCodex(request, workspaceDir, "execute");
          if (execResponse.type === "message") {
            saveMessage(conversationId, "assistant", execResponse.text);
            await deps.sendMessage(msg.chatId, execResponse.text || "(无输出)");
          }
          return;
        }
        saveMessage(conversationId, "assistant", response.text);
        await deps.sendMessage(msg.chatId, response.text);
      }
      return;
    }

    if (writeMode) {
      const response = await runCodex(request, workspaceDir, "proposal", { allowAutoExecute: false });
      if (response.type === "needs_approval") {
        const execResponse = await runCodex(request, workspaceDir, "execute");
        if (execResponse.type === "message") {
          saveMessage(conversationId, "assistant", execResponse.text);
          await deps.sendMessage(msg.chatId, execResponse.text || "(无输出)");
        }
        return;
      }

      if (response.text) {
        const inlineApproval = parseInlineApproval(response.text);
        if (inlineApproval) {
          const execResponse = await runCodex(request, workspaceDir, "execute");
          if (execResponse.type === "message") {
            saveMessage(conversationId, "assistant", execResponse.text);
            await deps.sendMessage(msg.chatId, execResponse.text || "(无输出)");
          }
          return;
        }
        if (response.blocked || response.parsed === false) {
          saveMessage(conversationId, "assistant", response.text);
          await deps.sendMessage(msg.chatId, response.text);
          return;
        }
        const execResponse = await runCodex(request, workspaceDir, "execute");
        if (execResponse.type === "message") {
          saveMessage(conversationId, "assistant", execResponse.text);
          await deps.sendMessage(msg.chatId, execResponse.text || "(无输出)");
        }
      }
      return;
    }

    const response = await runCodex(request, workspaceDir, "proposal");

    if (response.type === "needs_approval") {
      const payload = JSON.stringify({ type: "codex", request, workspaceDir });
      createApproval(response.approvalId, conversationId, payload);
      const preface = response.text ? `${response.text}\n\n` : "";
      await deps.sendMessage(
        msg.chatId,
        `${preface}需要确认后执行。\n摘要：${response.summary}\n回复“确认”继续，回复“取消”终止。`,
      );
      return;
    }

    if (response.text) {
      const inlineApproval = parseInlineApproval(response.text);
      if (inlineApproval) {
        const payload = JSON.stringify({ type: "codex", request, workspaceDir });
        const approvalId = `appr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        createApproval(approvalId, conversationId, payload);
        const preface = inlineApproval.response ? `${inlineApproval.response}\n\n` : "";
        await deps.sendMessage(
          msg.chatId,
          `${preface}需要确认后执行。\n摘要：${inlineApproval.summary || "准备执行更改"}\n回复“确认”继续，回复“取消”终止。`,
        );
        return;
      }
      saveMessage(conversationId, "assistant", response.text);
      await deps.sendMessage(msg.chatId, response.text);
    }
  } catch (err) {
    logger.error({ err }, "Codex run failed");
    await deps.sendMessage(msg.chatId, "执行失败，请稍后重试。");
  }
}

async function handleApprovalExecution(
  payload: string,
  deps: RouterDeps,
  conversationId: string,
  chatId: string,
): Promise<void> {
  try {
    const parsed = JSON.parse(payload) as
      | { type?: "codex"; request: AgentRequest; workspaceDir: string }
      | { type: "plugin"; action: "embed" | "sandbox_off"; name: string };

    if (parsed && typeof parsed === "object" && "type" in parsed && parsed.type === "plugin") {
      const manager = getPluginManager(deps);
      if (parsed.action === "embed") {
        manager.approveEmbed(parsed.name);
        await manager.setRuntimeMode(parsed.name, "embed", true);
        await deps.sendMessage(chatId, `已批准插件 ${parsed.name} 内嵌运行并立即生效。`);
        return;
      }
      if (parsed.action === "sandbox_off") {
        manager.approveSandboxOff(parsed.name);
        await manager.setSandboxMode(parsed.name, "off", true);
        await deps.sendMessage(chatId, `已批准插件 ${parsed.name} 关闭 sandbox 并立即生效。`);
        return;
      }
    }

    if (parsed && typeof parsed === "object" && "request" in parsed && "workspaceDir" in parsed) {
      const response = await runCodex(parsed.request, parsed.workspaceDir, "execute");
      if (response.type === "message") {
        saveMessage(conversationId, "assistant", response.text);
        await deps.sendMessage(chatId, response.text || "(无输出)");
      }
      return;
    }

    await deps.sendMessage(chatId, "审批内容无法识别，已忽略。");
  } catch (err) {
    logger.error({ err }, "Approval execution failed");
    await deps.sendMessage(chatId, "执行失败，请稍后重试。");
  }
}

function parseCommand(text: string): { name: string; args: string[] } | null {
  if (!text.startsWith("/")) return null;
  const parts = text.trim().split(/\s+/);
  const name = parts[0].slice(1);
  const args = parts.slice(1);
  return { name, args };
}

async function handleConfirmLast(
  conversationId: string,
  deps: RouterDeps,
  chatId: string,
): Promise<void> {
  setConfirmNext(conversationId, false);
  const recent = getRecentMessages(conversationId, Math.max(MAX_CONTEXT_MESSAGES, 50));
  let lastUserText: string | null = null;
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    const msg = recent[i];
    if (msg?.role === "user" && msg.content && !msg.content.trim().startsWith("/")) {
      lastUserText = msg.content;
      break;
    }
  }
  if (!lastUserText) {
    await deps.sendMessage(chatId, "没有可执行的上一条需求。请直接发送你的需求。");
    return;
  }

  const workspaceDir = resolveWorkspaceDir(conversationId);
  if (!isPathAllowed(workspaceDir)) {
    await deps.sendMessage(
      chatId,
      `当前工作目录不在安全目录内，请先设置允许的目录。\n允许目录：${getAllowedDirs().join(", ") || "(未限制)"}\n使用：/dir set <path>`,
    );
    return;
  }

  setConversationBackend(conversationId, "cli");
  const modelOverride = getEffectiveModel(conversationId) || undefined;
  const request: AgentRequest = {
    conversationId,
    userText: lastUserText,
    modelOverride,
    backendOverride: "cli",
    contextMessages: recent,
  };

  try {
    const response = await runCodex(request, workspaceDir, "proposal");
    const inlineApproval = response.text ? parseInlineApproval(response.text) : null;
    if (response.type === "needs_approval" || inlineApproval) {
      const execResponse = await runCodex(request, workspaceDir, "execute");
      if (execResponse.type === "message") {
        saveMessage(conversationId, "assistant", execResponse.text);
        await deps.sendMessage(chatId, execResponse.text || "(无输出)");
      }
      return;
    }
    if (response.text) {
      saveMessage(conversationId, "assistant", response.text);
      await deps.sendMessage(chatId, response.text);
    }
  } catch (err) {
    logger.error({ err }, "Confirm last execution failed");
    await deps.sendMessage(chatId, "执行失败，请稍后重试。");
  }
}

type InlineApproval = {
  summary: string;
  response: string;
};

function parseInlineApproval(text: string): InlineApproval | null {
  const needsMatch = text.match(/NEEDS_APPROVAL\s*[:：]\s*(yes|no)/i);
  if (!needsMatch || needsMatch[1].toLowerCase() !== "yes") return null;
  const summary = extractInlineSection(text, "SUMMARY");
  const response = extractInlineSection(text, "RESPONSE");
  return { summary, response };
}

function extractInlineSection(text: string, label: string): string {
  const pattern = new RegExp(`${label}\\s*[:：]\\s*([\\s\\S]*?)(\\n[A-Z_]+\\s*[:：]|$)`, "i");
  const match = text.match(pattern);
  return match?.[1]?.trim() || "";
}

function resolveWorkspaceDir(conversationId: string): string {
  const existing = getConversationWorkspace(conversationId);
  if (existing) return existing;
  const defaultDir = path.join(DATA_DIR, "workspaces", conversationId);
  setConversationWorkspace(conversationId, defaultDir);
  return defaultDir;
}

function expandHomeDir(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

function getAllowedDirs(): string[] {
  return [...SAFE_DIRS, ...getSafeDirs()];
}

function isPathAllowed(target: string): boolean {
  const allowed = getAllowedDirs();
  if (allowed.length === 0) return true;
  const resolved = path.resolve(target);
  for (const root of allowed) {
    const normalized = path.resolve(root);
    if (resolved === normalized) return true;
    if (resolved.startsWith(`${normalized}${path.sep}`)) return true;
  }
  return false;
}

async function handleCommand(
  command: { name: string; args: string[] },
  conversationId: string,
  plugin: string | null,
  deps: RouterDeps,
  chatId: string,
): Promise<void> {
  if (PLUGINS.includes(command.name as (typeof PLUGINS)[number])) {
    setConversationPlugin(conversationId, command.name);
    await deps.sendMessage(chatId, `已进入 ${command.name} 插件。输入 /help 查看可用指令。`);
    return;
  }

  if (command.name === "exit") {
    clearConversationPlugin(conversationId);
    await deps.sendMessage(chatId, "已退出当前插件。");
    return;
  }

  if (CODEX_ONLY_COMMANDS.has(command.name) && plugin !== "codex") {
    await deps.sendMessage(chatId, "当前不在 Codex 插件中，请先输入 /codex。");
    return;
  }

  switch (command.name) {
    case "help":
      await deps.sendMessage(chatId, buildHelpMessage(plugin));
      return;
    case "cli":
      {
        const wantsWrite = command.args.includes("--write") || command.args.includes("write");
        const wantsSafe =
          command.args.includes("--safe") ||
          command.args.includes("safe") ||
          command.args.includes("--ask") ||
          command.args.includes("ask");
        if (wantsWrite && wantsSafe) {
          await deps.sendMessage(chatId, "用法：/cli 或 /cli --write 或 /cli --safe");
          return;
        }
        setConversationBackend(conversationId, "cli");
        if (wantsWrite) {
          setWriteMode(conversationId, true);
          setConfirmNext(conversationId, false);
          await deps.sendMessage(chatId, "已切换到 CLI 并进入写入模式（除禁止命令外将自动执行）。");
          return;
        }
        if (wantsSafe) {
          setWriteMode(conversationId, false);
          setConfirmNext(conversationId, false);
          await deps.sendMessage(chatId, "已切换到 CLI，并退出写入模式。");
          return;
        }
        const writeMode = getWriteMode(conversationId);
        const suffix = writeMode ? "（写入模式已开启）" : "（执行前可能需要确认）";
        await deps.sendMessage(chatId, `已切换到 CLI 后端${suffix}。`);
        return;
      }
    case "backend": {
      const backend = (getConversationBackend(conversationId) || CODEX_BACKEND).toLowerCase();
      const label = backend === "sdk" ? "SDK（线程持续对话）" : "CLI（单次执行）";
      await deps.sendMessage(chatId, `当前后端：${label}`);
      return;
    }
    case "mode": {
      const backend = (getConversationBackend(conversationId) || CODEX_BACKEND).toLowerCase();
      const confirmNext = getConfirmNext(conversationId);
      const writeMode = getWriteMode(conversationId);
      const hints: string[] = [];
      if (writeMode) hints.push("持续自动执行");
      if (confirmNext) hints.push("下一条将自动执行");
      const hint = hints.length ? `（${hints.join("；")}）` : "";
      if (backend === "sdk") {
        const extra = writeMode ? "写入模式仅对 CLI 生效。" : "";
        await deps.sendMessage(
          chatId,
          `当前模式：SDK（不执行本地命令/写文件）。需要执行请切换 /cli。${extra}${hint}`,
        );
        return;
      }
      await deps.sendMessage(chatId, `当前模式：CLI（workspace-write，执行前可能需要确认）。${hint}`);
      return;
    }
    case "status": {
      const workspaceDir = resolveWorkspaceDir(conversationId);
      const backend = (getConversationBackend(conversationId) || CODEX_BACKEND).toLowerCase();
      const backendLabel = backend === "sdk" ? "SDK" : "CLI";
      const cliSessionId =
        getConversationCliSessionId(conversationId) || getCliSessionIdForWorkspace(workspaceDir);
      const threadId =
        getConversationThreadId(conversationId) || getThreadIdForWorkspace(workspaceDir);
      const confirmNext = getConfirmNext(conversationId);
      const writeMode = getWriteMode(conversationId);
      const lines = [
        `目录：${workspaceDir}`,
        `后端：${backendLabel}`,
        `CLI session：${cliSessionId || "(无)"}`,
        `SDK thread：${threadId || "(无)"}`,
        `写入模式：${writeMode ? "on" : "off"}${confirmNext ? "（下一条自动执行）" : ""}`,
      ];
      await deps.sendMessage(chatId, lines.join("\n"));
      return;
    }
    case "dir":
      await handleWorkspaceCommand(command.args, conversationId, deps, chatId);
      return;
    case "git":
      await handleGitCommand(command.args, conversationId, deps, chatId);
      return;
    case "confirm": {
      const sub = command.args[0];
      if (sub === "--last" || sub === "last") {
        await handleConfirmLast(conversationId, deps, chatId);
        return;
      }
      await deps.sendMessage(chatId, "当前没有待确认的操作。如需执行上一条需求，请用 /confirm --last。");
      return;
    }
    case "restart": {
      await handleRestartCommand(deps, chatId);
      return;
    }
    case "cancel": {
      if (getConfirmNext(conversationId)) {
        setConfirmNext(conversationId, false);
        await deps.sendMessage(chatId, "已取消一次性写入模式。");
        return;
      }
      if (getWriteMode(conversationId)) {
        setWriteMode(conversationId, false);
        await deps.sendMessage(chatId, "已退出写入模式。");
        return;
      }
      await deps.sendMessage(chatId, "当前没有待确认的操作。");
      return;
    }
    case "resume": {
      if (command.args.length < 1) {
        await deps.sendMessage(chatId, "用法：/resume <id>");
        return;
      }
      const modeArg = command.args[0];
      const resolvedBackend = (getConversationBackend(conversationId) || CODEX_BACKEND).toLowerCase();
      const mode = resolvedBackend === "sdk" ? "sdk" : "cli";
      const id = command.args[0];
      if (!id) {
        await deps.sendMessage(chatId, "用法：/resume <id>");
        return;
      }

      if (mode === "cli") {
        const mappedWorkspace = getWorkspaceForCliSessionId(id);
        const workspaceDir = mappedWorkspace || resolveWorkspaceDir(conversationId);
        if (mappedWorkspace) {
          setConversationWorkspace(conversationId, mappedWorkspace);
        }
        if (!isPathAllowed(workspaceDir)) {
          await deps.sendMessage(
            chatId,
            `当前工作目录不在安全目录内，请先设置允许的目录。\n允许目录：${getAllowedDirs().join(", ") || "(未限制)"}\n使用：/dir set <path>`,
          );
          return;
        }
        setConversationCliSessionId(conversationId, id);
        setCliSessionIdForWorkspace(workspaceDir, id);
        setWorkspaceForCliSessionId(id, workspaceDir);
        setConversationBackend(conversationId, "cli");
        const history = formatLastExchange(getRecentMessages(conversationId, 10));
        await deps.sendMessage(
          chatId,
          `已绑定 CLI 会话：${id}\n${history}`,
        );
        return;
      }

      const threadId = id;
      const mappedWorkspace = getWorkspaceForThreadId(threadId);
      const workspaceDir = mappedWorkspace || resolveWorkspaceDir(conversationId);
      if (mappedWorkspace) {
        setConversationWorkspace(conversationId, mappedWorkspace);
      }
      if (!isPathAllowed(workspaceDir)) {
        await deps.sendMessage(
          chatId,
          `当前工作目录不在安全目录内，请先设置允许的目录。\n允许目录：${getAllowedDirs().join(", ") || "(未限制)"}\n使用：/dir set <path>`,
        );
        return;
      }
      setConversationThreadId(conversationId, threadId);
      setThreadIdForWorkspace(workspaceDir, threadId);
      setWorkspaceForThreadId(threadId, workspaceDir);
      setConversationBackend(conversationId, "sdk");
      resetCodexThread(conversationId);
      const history = formatLastExchange(getRecentMessages(conversationId, 10));
      await deps.sendMessage(
        chatId,
        `已绑定线程并切换到 SDK：${threadId}\n${history}`,
      );
      return;
    }
    case "reset":
      clearConversation(conversationId);
      resetCodexThread(conversationId);
      resetCodexCliSession(conversationId);
      if (command.args.includes("--hard") || command.args.includes("hard")) {
        const workspaceDir = resolveWorkspaceDir(conversationId);
        const threadId = getThreadIdForWorkspace(workspaceDir);
        const cliSessionId = getCliSessionIdForWorkspace(workspaceDir);
        clearThreadIdForWorkspace(workspaceDir);
        if (threadId) {
          clearWorkspaceForThreadId(threadId);
        }
        clearCliSessionIdForWorkspace(workspaceDir);
        if (cliSessionId) {
          clearWorkspaceForCliSessionId(cliSessionId);
        }
        await deps.sendMessage(chatId, "已清空当前会话记忆，并重置线程（hard reset）。");
        return;
      }
      await deps.sendMessage(chatId, "已清空当前会话记忆（可通过同一目录恢复线程）。");
      return;
    case "model":
      await handleModelCommand(command.args, conversationId, deps, chatId);
      return;
    case "plugin":
      await handlePluginCommand(command.args, conversationId, deps, chatId);
      return;
    case "p":
      await handlePluginDirect(command.args, conversationId, deps, chatId);
      return;
    default:
      await deps.sendMessage(chatId, "未知指令。输入 /help 查看可用命令。");
  }
}

async function handleModelCommand(
  args: string[],
  conversationId: string,
  deps: RouterDeps,
  chatId: string,
): Promise<void> {
  if (args.length === 0) {
    const model = getEffectiveModel(conversationId);
    if (model) {
      await deps.sendMessage(chatId, `当前模型：${model}`);
    } else {
      await deps.sendMessage(chatId, "当前未设置模型，使用 Codex 默认配置。\n可用 /model set <name> 设置。");
    }
    return;
  }

  if (args[0] === "set" && args.length >= 2) {
    if (args[1] === "--global") {
      const model = args[2];
      if (!model) {
        await deps.sendMessage(chatId, "请提供模型名，例如：/model set --global gpt-5");
        return;
      }
      setGlobalModel(model);
      await deps.sendMessage(chatId, `全局默认模型已设置为 ${model}`);
      return;
    }

    const model = args[1];
    setConversationModel(conversationId, model);
    await deps.sendMessage(chatId, `当前会话模型已设置为 ${model}`);
    return;
  }

  await deps.sendMessage(chatId, "用法：/model 或 /model set <name> 或 /model set --global <name>");
}

async function handleWorkspaceCommand(
  args: string[],
  conversationId: string,
  deps: RouterDeps,
  chatId: string,
): Promise<void> {
  if (args.length === 0) {
    const workspaceDir = resolveWorkspaceDir(conversationId);
    await deps.sendMessage(chatId, `当前目录：${workspaceDir}`);
    return;
  }

  if (args[0] === "set" && args.length >= 2) {
    const rawPath = args.slice(1).join(" ");
    const expanded = expandHomeDir(rawPath);
    const baseDir = resolveWorkspaceDir(conversationId);
    const workspaceDir = path.isAbsolute(expanded)
      ? path.resolve(expanded)
      : path.resolve(baseDir, expanded);
    addSafeDir(workspaceDir);
    if (!isPathAllowed(workspaceDir)) {
      await deps.sendMessage(
        chatId,
        `目录不在安全范围内，已拒绝。\n允许目录：${getAllowedDirs().join(", ") || "(未限制)"}`,
      );
      return;
    }
    setConversationWorkspace(conversationId, workspaceDir);
    resetCodexThread(conversationId);
    resetCodexCliSession(conversationId);
    const restoredCliSessionId = getCliSessionIdForWorkspace(workspaceDir);
    const restoredThreadId = getThreadIdForWorkspace(workspaceDir);
    if (restoredCliSessionId) {
      setConversationCliSessionId(conversationId, restoredCliSessionId);
    }
    if (restoredThreadId) {
      setConversationThreadId(conversationId, restoredThreadId);
    }
    const restoredNotes: string[] = [];
    if (restoredCliSessionId) restoredNotes.push(`CLI session：${restoredCliSessionId}`);
    if (restoredThreadId) restoredNotes.push(`SDK thread：${restoredThreadId}`);
    const suffix = restoredNotes.length ? `\n已恢复绑定：${restoredNotes.join("，")}` : "";
    await deps.sendMessage(chatId, `已设置工作目录：${workspaceDir}（已更新绑定）${suffix}`);
    return;
  }

  await deps.sendMessage(chatId, "用法：/dir 或 /dir set <path>");
}

async function handleGitCommand(
  args: string[],
  conversationId: string,
  deps: RouterDeps,
  chatId: string,
): Promise<void> {
  if (args.length === 0) {
    await deps.sendMessage(chatId, "用法：/git ci [message] 或 /git push 或 /git diff");
    return;
  }
  const workspaceDir = resolveWorkspaceDir(conversationId);
  if (!isPathAllowed(workspaceDir)) {
    await deps.sendMessage(
      chatId,
      `当前工作目录不在安全目录内，请先设置允许的目录。\n允许目录：${getAllowedDirs().join(", ") || "(未限制)"}\n使用：/dir set <path>`,
    );
    return;
  }

  try {
    const repoCheck = await runShell("git", ["rev-parse", "--show-toplevel"], workspaceDir);
    if (repoCheck.code !== 0) {
      await deps.sendMessage(chatId, "当前目录不是 git 仓库，请先 /dir set 到仓库目录。");
      return;
    }

    const sub = args[0];
    if (sub === "ci" || sub === "commit") {
      const status = await runShell("git", ["status", "--porcelain"], workspaceDir);
      if (!status.stdout.trim()) {
        await deps.sendMessage(chatId, "工作区无改动，无需提交。");
        return;
      }

      const addResult = await runShell("git", ["add", "-A"], workspaceDir);
      if (addResult.code !== 0) {
        await deps.sendMessage(
          chatId,
          `git add 失败：${formatShellError(addResult)}`,
        );
        return;
      }

      const message = args.slice(1).join(" ").trim() ||
        buildAutoCommitMessage(status.stdout);
      const commitResult = await runShell("git", ["commit", "-m", message], workspaceDir);
      if (commitResult.code !== 0) {
        await deps.sendMessage(
          chatId,
          `git commit 失败：${formatShellError(commitResult)}`,
        );
        return;
      }
      await deps.sendMessage(
        chatId,
        `已提交：${message}\n${(commitResult.stdout || commitResult.stderr).trim() || "(无输出)"}`,
      );
      return;
    }

    if (sub === "push") {
      const pushResult = await runShell("git", ["push"], workspaceDir);
      if (pushResult.code !== 0) {
        await deps.sendMessage(
          chatId,
          `git push 失败：${formatShellError(pushResult)}`,
        );
        return;
      }
      await deps.sendMessage(
        chatId,
        `推送完成。\n${(pushResult.stdout || pushResult.stderr).trim() || "(无输出)"}`,
      );
      return;
    }

    if (sub === "diff") {
      const diffResult = await runShell("git", ["diff", "--numstat"], workspaceDir);
      if (diffResult.code !== 0) {
        await deps.sendMessage(
          chatId,
          `git diff 失败：${formatShellError(diffResult)}`,
        );
        return;
      }
      const list = diffResult.stdout.trim();
      if (!list) {
        await deps.sendMessage(chatId, "没有检测到未提交的变更。");
        return;
      }
      const lines = list.split(/\r?\n/).map((line) => {
        const [added, removed, file] = line.split(/\t+/);
        if (!file) return line;
        return `${file}: +${added || "0"} / -${removed || "0"}`;
      });
      await deps.sendMessage(chatId, `变更文件：\n${lines.join("\n")}`);
      return;
    }

    await deps.sendMessage(chatId, "用法：/git ci [message] 或 /git push 或 /git diff");
  } catch (err) {
    await deps.sendMessage(chatId, `git 执行失败：${String(err)}`);
  }
}

async function handleRestartCommand(
  deps: RouterDeps,
  chatId: string,
): Promise<void> {
  try {
    setRestartNotifyChatId(chatId);
    const { cmd, args } = splitCommand(RESTART_CMD);
    const child = spawn(cmd, args, {
      cwd: PROJECT_ROOT,
      env: process.env,
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    await deps.sendMessage(chatId, "正在重启服务…");
    process.exit(0);
  } catch (err) {
    await deps.sendMessage(chatId, `重启失败：${String(err)}`);
  }
}

function splitCommand(raw: string): { cmd: string; args: string[] } {
  const parts = raw.trim().split(/\s+/).filter(Boolean);
  const cmd = parts[0] || "npm";
  const args = parts.length > 1 ? parts.slice(1) : ["run", "dev"];
  return { cmd, args };
}

type ShellResult = { code: number; stdout: string; stderr: string };

function buildAutoCommitMessage(statusOutput: string): string {
  const lines = statusOutput.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const files = lines.map((line) => {
    const trimmed = line.replace(/^\?\?\s+/, "").replace(/^[A-Z.][A-Z.]\s+/, "");
    return trimmed.split(" -> ").slice(-1)[0];
  }).filter(Boolean);
  const unique = Array.from(new Set(files));
  if (unique.length === 0) {
    return "chore: update files";
  }
  if (unique.length === 1) {
    return `chore: update ${unique[0]}`;
  }
  const preview = unique.slice(0, 3).join(", ");
  const suffix = unique.length > 3 ? ", ..." : "";
  return `chore: update ${unique.length} files (${preview}${suffix})`;
}

async function runShell(cmd: string, args: string[], cwd: string): Promise<ShellResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd, env: process.env });
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("error", (err) => {
      reject(err);
    });
    proc.on("close", (code) => {
      resolve({ code: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

function formatShellError(result: ShellResult): string {
  const output = result.stderr || result.stdout || `code=${result.code}`;
  return output.trim();
}

function formatLastExchange(messages: Array<{ role: "user" | "assistant"; content: string }>): string {
  if (messages.length === 0) return "暂无历史记录。";

  let lastAssistantIndex = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "assistant") {
      lastAssistantIndex = i;
      break;
    }
  }

  if (lastAssistantIndex === -1) {
    const last = messages[messages.length - 1];
    return `最近一条记录：\n用户：${last.content}`;
  }

  let lastUserIndex = -1;
  for (let i = lastAssistantIndex - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "user") {
      lastUserIndex = i;
      break;
    }
  }

  if (lastUserIndex === -1) {
    const last = messages[lastAssistantIndex];
    return `最近一条记录：\n助手：${last.content}`;
  }

  const userText = messages[lastUserIndex].content;
  const assistantText = messages[lastAssistantIndex].content;
  return `最近一次对话：\n用户：${userText}\n助手：${assistantText}`;
}

function buildHelpMessage(plugin: string | null): string {
  const lines = ["可用指令：", "/help", "/exit"];
  if (!plugin) {
    lines.push(
      "/codex",
      "/plugin list",
      "/plugin info <name>",
      "/plugin install <path>",
      "/plugin uninstall <name>",
      "/plugin enable|disable <name>",
      "/plugin approve <name>",
      "/plugin runtime <name> isolate|embed",
      "/plugin sandbox <name> on|off",
      "/plugin use <name>",
      "/p <name> <cmd>",
    );
    return lines.join("\n");
  }

  if (plugin === "codex") {
    lines.push(
      "/codex",
      "/reset",
      "/model",
      "/model set <name>",
      "/model set --global <name>",
      "/cli [--write|--safe]",
      "/backend",
      "/mode",
      "/status",
      "/dir",
      "/dir set <path>",
      "/confirm",
      "/confirm --last",
      "/cancel",
      "/restart",
      "/git ci [message]",
      "/git diff (显示行数统计)",
      "/git push",
      "/resume <id>",
      "/reset --hard",
    );
    lines.push(
      "/plugin list",
      "/plugin info <name>",
      "/plugin install <path>",
      "/plugin uninstall <name>",
      "/plugin enable|disable <name>",
      "/plugin approve <name>",
      "/plugin runtime <name> isolate|embed",
      "/plugin sandbox <name> on|off",
      "/plugin use <name>",
      "/p <name> <cmd>",
    );
    return lines.join("\n");
  }

  lines.push(
    "/codex",
    "/plugin list",
    "/plugin info <name>",
    "/plugin install <path>",
    "/plugin uninstall <name>",
    "/plugin enable|disable <name>",
    "/plugin use <name>",
    "/plugin approve <name>",
    "/plugin runtime <name> isolate|embed",
    "/plugin sandbox <name> on|off",
    "/p <name> <cmd>",
  );
  return lines.join("\n");
}

async function handlePluginCommand(
  args: string[],
  conversationId: string,
  deps: RouterDeps,
  chatId: string,
): Promise<void> {
  try {
    const manager = getPluginManager(deps);
    const sub = args[0] || "list";
    if (sub === "list") {
      const items = manager.list();
      if (items.length === 0) {
        await deps.sendMessage(chatId, "暂无已安装插件。");
        return;
      }
      const lines = items.map((entry) => {
        const status = entry.enabled ? "enabled" : "disabled";
        return `${entry.name}@${entry.version} (${status})`;
      });
      await deps.sendMessage(chatId, `已安装插件：\n${lines.join("\n")}`);
      return;
    }

    if (sub === "info") {
      const name = args[1];
      if (!name) {
        await deps.sendMessage(chatId, "用法：/plugin info <name>");
        return;
      }
      const entry = manager.get(name);
      if (!entry) {
        await deps.sendMessage(chatId, `插件 ${name} 未安装。`);
        return;
      }
      const effective = manager.getEffectiveRuntime(entry);
      const lines = [
        `名称：${entry.name}`,
        `版本：${entry.version}`,
        `路径：${entry.path}`,
        `状态：${entry.enabled ? "enabled" : "disabled"}`,
        `配置：${entry.runtime.mode}/${entry.runtime.sandbox}`,
        `生效：${effective.mode}/${effective.sandbox}`,
        `内嵌审批：${entry.approvedEmbed ? "yes" : "no"}`,
        `sandbox-off 审批：${entry.approvedSandboxOff ? "yes" : "no"}`,
      ];
      await deps.sendMessage(chatId, lines.join("\n"));
      return;
    }

    if (sub === "install") {
      const src = args.slice(1).join(" ").trim();
      if (!src) {
        await deps.sendMessage(chatId, "用法：/plugin install <path>");
        return;
      }
      const baseDir = resolveWorkspaceDir(conversationId);
      const resolved = path.isAbsolute(src) ? path.resolve(src) : path.resolve(baseDir, src);
      const entry = await manager.installFromPath(resolved);
      await deps.sendMessage(chatId, `插件已安装：${entry.name}@${entry.version}`);
      return;
    }

    if (sub === "uninstall") {
      const name = args[1];
      if (!name) {
        await deps.sendMessage(chatId, "用法：/plugin uninstall <name>");
        return;
      }
      await manager.uninstall(name);
      await deps.sendMessage(chatId, `插件已卸载：${name}`);
      return;
    }

    if (sub === "enable") {
      const name = args[1];
      if (!name) {
        await deps.sendMessage(chatId, "用法：/plugin enable <name>");
        return;
      }
      await manager.enable(name);
      await deps.sendMessage(chatId, `插件已启用：${name}`);
      return;
    }

    if (sub === "disable") {
      const name = args[1];
      if (!name) {
        await deps.sendMessage(chatId, "用法：/plugin disable <name>");
        return;
      }
      await manager.disable(name);
      await deps.sendMessage(chatId, `插件已禁用：${name}`);
      return;
    }

    if (sub === "approve") {
      const name = args[1];
      if (!name) {
        await deps.sendMessage(chatId, "用法：/plugin approve <name>");
        return;
      }
      manager.approveEmbed(name);
      await deps.sendMessage(chatId, `插件 ${name} 已允许内嵌运行。`);
      return;
    }

    if (sub === "runtime") {
      const name = args[1];
      const mode = args[2] as "isolate" | "embed" | undefined;
      if (!name || !mode) {
        await deps.sendMessage(chatId, "用法：/plugin runtime <name> isolate|embed");
        return;
      }
      if (mode !== "isolate" && mode !== "embed") {
        await deps.sendMessage(chatId, "用法：/plugin runtime <name> isolate|embed");
        return;
      }
      const entry = manager.get(name);
      if (!entry) {
        await deps.sendMessage(chatId, `插件 ${name} 未安装。`);
        return;
      }
      if (mode === "embed" && !entry.approvedEmbed) {
        createPluginApproval("embed", name, conversationId);
        await deps.sendMessage(
          chatId,
          `需要确认后执行。\n摘要：允许插件 ${name} 以内嵌模式运行\n回复“确认”继续，回复“取消”终止。`,
        );
        return;
      }
      await manager.setRuntimeMode(name, mode);
      await deps.sendMessage(chatId, `插件 ${name} 运行模式已设置为 ${mode}。`);
      return;
    }

    if (sub === "sandbox") {
      const name = args[1];
      const mode = args[2] as "on" | "off" | undefined;
      if (!name || !mode) {
        await deps.sendMessage(chatId, "用法：/plugin sandbox <name> on|off");
        return;
      }
      if (mode !== "on" && mode !== "off") {
        await deps.sendMessage(chatId, "用法：/plugin sandbox <name> on|off");
        return;
      }
      const entry = manager.get(name);
      if (!entry) {
        await deps.sendMessage(chatId, `插件 ${name} 未安装。`);
        return;
      }
      if (mode === "off" && !entry.approvedSandboxOff) {
        createPluginApproval("sandbox_off", name, conversationId);
        await deps.sendMessage(
          chatId,
          `需要确认后执行。\n摘要：允许插件 ${name} 在隔离模式关闭 sandbox\n回复“确认”继续，回复“取消”终止。`,
        );
        return;
      }
      await manager.setSandboxMode(name, mode);
      await deps.sendMessage(chatId, `插件 ${name} sandbox 已设置为 ${mode}。`);
      return;
    }

    if (sub === "use") {
      const name = args[1];
      if (!name) {
        await deps.sendMessage(chatId, "用法：/plugin use <name>");
        return;
      }
      if (!manager.isInstalled(name) || !manager.isEnabled(name)) {
        await deps.sendMessage(chatId, `插件 ${name} 未安装或已禁用。`);
        return;
      }
      setConversationPlugin(conversationId, name);
      await deps.sendMessage(chatId, `已进入 ${name} 插件。输入 /help 查看可用指令。`);
      return;
    }

    await deps.sendMessage(
      chatId,
      "用法：/plugin list|info|install|uninstall|enable|disable|approve|runtime|sandbox|use",
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await deps.sendMessage(chatId, `插件操作失败：${message}`);
  }
}

function createPluginApproval(
  action: "embed" | "sandbox_off",
  name: string,
  conversationId: string,
): string {
  const approvalId = `appr_plugin_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const payload = JSON.stringify({ type: "plugin", action, name });
  createApproval(approvalId, conversationId, payload);
  return approvalId;
}

async function handlePluginDirect(
  args: string[],
  conversationId: string,
  deps: RouterDeps,
  chatId: string,
): Promise<void> {
  try {
    if (args.length < 2) {
      await deps.sendMessage(chatId, "用法：/p <plugin> <cmd> [args...]");
      return;
    }
    const name = args[0];
    const cmd = args[1];
    const cmdArgs = args.slice(2);
    const manager = getPluginManager(deps);
    if (!manager.isInstalled(name) || !manager.isEnabled(name)) {
      await deps.sendMessage(chatId, `插件 ${name} 未安装或已禁用。`);
      return;
    }
    const workspaceDir = resolveWorkspaceDir(conversationId);
    await manager.handleCommand(
      name,
      cmd,
      cmdArgs,
      {
        conversationId,
        chatId,
        workspaceDir,
      },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await deps.sendMessage(chatId, `插件命令执行失败：${message}`);
  }
}
