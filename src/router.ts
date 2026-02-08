import os from "os";
import path from "path";

import { CODEX_BACKEND, DATA_DIR, MAX_CONTEXT_MESSAGES, SAFE_DIRS } from "./config.js";
import { resetCodexCliSession, resetCodexThread, runCodex } from "./codex/runner.js";
import { logger } from "./logger.js";
import {
  clearThreadIdForWorkspace,
  clearConversation,
  clearCliSessionIdForWorkspace,
  clearWorkspaceForCliSessionId,
  clearWorkspaceForThreadId,
  createApproval,
  getCliSessionIdForWorkspace,
  getConversationBackend,
  getConversationPlugin,
  getConversationWorkspace,
  getEffectiveModel,
  getOrCreateConversation,
  getPendingApproval,
  getRecentMessages,
  getThreadIdForWorkspace,
  getWorkspaceForCliSessionId,
  getWorkspaceForThreadId,
  saveMessage,
  setCliSessionIdForWorkspace,
  setConversationCliSessionId,
  setConversationWorkspace,
  setConversationPlugin,
  clearConversationPlugin,
  setConversationBackend,
  setConversationModel,
  setConversationThreadId,
  setGlobalModel,
  setThreadIdForWorkspace,
  setWorkspaceForCliSessionId,
  setWorkspaceForThreadId,
  updateApprovalStatus,
} from "./store/db.js";
import { AgentRequest, InboundMessage } from "./types.js";

export interface RouterDeps {
  sendMessage: (chatId: string, text: string) => Promise<void>;
}

const CONFIRM_PATTERN = /^(yes|y|确认|好|ok|执行)$/i;
const REJECT_PATTERN = /^(no|n|取消|不要|stop)$/i;
const PLUGINS = ["codex"] as const;
const CODEX_ONLY_COMMANDS = new Set([
  "cli",
  "sdk",
  "backend",
  "dir",
  "mode",
  "model",
  "resume",
]);

export async function handleInbound(
  msg: InboundMessage,
  deps: RouterDeps,
): Promise<void> {
  const conversationId = getOrCreateConversation(msg.chatId, msg.isGroup);
  const plugin = getConversationPlugin(conversationId);

  const pending = getPendingApproval(conversationId);
  if (pending) {
    const text = msg.text.trim();
    if (text.startsWith("/") && text.slice(1).trim().toLowerCase() === "exit") {
      updateApprovalStatus(pending.id, "rejected");
      clearConversationPlugin(conversationId);
      await deps.sendMessage(msg.chatId, "已退出当前插件，并取消待确认操作。");
      return;
    }
    if (CONFIRM_PATTERN.test(text)) {
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

  const command = parseCommand(msg.text);
  if (command) {
    await handleCommand(command, conversationId, plugin, deps, msg.chatId);
    return;
  }

  if (!plugin) {
    await deps.sendMessage(msg.chatId, "当前未进入任何插件。请输入 /codex 进入 Codex 插件，或 /help 查看指令。");
    return;
  }

  if (plugin !== "codex") {
    await deps.sendMessage(msg.chatId, `当前插件 ${plugin} 暂未实现处理逻辑。`);
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
      `当前工作目录不在安全目录内，请先设置允许的目录。\n允许目录：${SAFE_DIRS.join(", ") || "(未限制)"}\n使用：/dir set <path>`,
    );
    return;
  }
  const contextMessages = getRecentMessages(conversationId, MAX_CONTEXT_MESSAGES);

  const request: AgentRequest = {
    conversationId,
    userText: msg.text,
    modelOverride,
    backendOverride,
    contextMessages,
  };

  saveMessage(conversationId, "user", msg.text, msg.timestamp);

  try {
    const response = await runCodex(request, workspaceDir, "proposal");

    if (response.type === "needs_approval") {
      const payload = JSON.stringify({ request, workspaceDir });
      createApproval(response.approvalId, conversationId, payload);
      const preface = response.text ? `${response.text}\n\n` : "";
      await deps.sendMessage(
        msg.chatId,
        `${preface}需要确认后执行。\n摘要：${response.summary}\n回复“确认”继续，回复“取消”终止。`,
      );
      return;
    }

    if (response.text) {
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
    const parsed = JSON.parse(payload) as { request: AgentRequest; workspaceDir: string };
    const response = await runCodex(parsed.request, parsed.workspaceDir, "execute");
    if (response.type === "message") {
      saveMessage(conversationId, "assistant", response.text);
      await deps.sendMessage(chatId, response.text || "(无输出)");
    }
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

function isPathAllowed(target: string): boolean {
  if (SAFE_DIRS.length === 0) return true;
  const resolved = path.resolve(target);
  for (const root of SAFE_DIRS) {
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
      setConversationBackend(conversationId, "cli");
      await deps.sendMessage(chatId, "已切换到 CLI 后端（单次执行）。");
      return;
    case "sdk":
      setConversationBackend(conversationId, "sdk");
      await deps.sendMessage(chatId, "已切换到 SDK 后端（线程持续对话）。");
      return;
    case "backend": {
      const backend = (getConversationBackend(conversationId) || CODEX_BACKEND).toLowerCase();
      const label = backend === "sdk" ? "SDK（线程持续对话）" : "CLI（单次执行）";
      await deps.sendMessage(chatId, `当前后端：${label}`);
      return;
    }
    case "mode": {
      const backend = (getConversationBackend(conversationId) || CODEX_BACKEND).toLowerCase();
      if (backend === "sdk") {
        await deps.sendMessage(chatId, "当前模式：SDK（不执行本地命令/写文件）。需要执行请切换 /cli。");
        return;
      }
      await deps.sendMessage(chatId, "当前模式：CLI（workspace-write，执行前可能需要确认）。");
      return;
    }
    case "dir":
      await handleWorkspaceCommand(command.args, conversationId, deps, chatId);
      return;
    case "resume": {
      if (command.args.length < 1) {
        await deps.sendMessage(chatId, "用法：/resume <id> 或 /resume cli <sessionId> 或 /resume sdk <threadId>");
        return;
      }
      const modeArg = command.args[0];
      const explicitMode = modeArg === "cli" || modeArg === "sdk";
      const resolvedBackend = (getConversationBackend(conversationId) || CODEX_BACKEND).toLowerCase();
      const mode = explicitMode
        ? modeArg
        : resolvedBackend === "sdk"
          ? "sdk"
          : "cli";
      const id = explicitMode ? command.args[1] : command.args[0];
      if (!id) {
        await deps.sendMessage(chatId, "用法：/resume <id> 或 /resume cli <sessionId> 或 /resume sdk <threadId>");
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
            `当前工作目录不在安全目录内，请先设置允许的目录。\n允许目录：${SAFE_DIRS.join(", ") || "(未限制)"}\n使用：/dir set <path>`,
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
          `当前工作目录不在安全目录内，请先设置允许的目录。\n允许目录：${SAFE_DIRS.join(", ") || "(未限制)"}\n使用：/dir set <path>`,
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
    const workspaceDir = path.resolve(expandHomeDir(rawPath));
    if (!isPathAllowed(workspaceDir)) {
      await deps.sendMessage(
        chatId,
        `目录不在安全范围内，已拒绝。\n允许目录：${SAFE_DIRS.join(", ") || "(未限制)"}`,
      );
      return;
    }
    setConversationWorkspace(conversationId, workspaceDir);
    resetCodexThread(conversationId);
    resetCodexCliSession(conversationId);
    await deps.sendMessage(chatId, `已设置工作目录：${workspaceDir}（已重置线程绑定）`);
    return;
  }

  await deps.sendMessage(chatId, "用法：/dir 或 /dir set <path>");
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
    lines.push("/codex");
    return lines.join("\n");
  }

  if (plugin === "codex") {
    lines.push(
      "/codex",
      "/reset",
      "/model",
      "/model set <name>",
      "/model set --global <name>",
      "/cli",
      "/sdk",
      "/backend",
      "/mode",
      "/dir",
      "/dir set <path>",
      "/resume <id>",
      "/resume cli <sessionId>",
      "/resume sdk <threadId>",
      "/reset --hard",
    );
    return lines.join("\n");
  }

  lines.push("/codex");
  return lines.join("\n");
}
