import { FEISHU_BOT_NAME, FEISHU_BOT_OPEN_ID, FEISHU_RTM_ENABLED } from "./config.js";
import { sendFeishuMessage } from "./feishu/api.js";
import { FeishuRtmClient } from "./feishu/rtm.js";
import { logger } from "./logger.js";
import { handleInbound, handleInboundFast } from "./router.js";
import { getSharedPluginManager } from "./plugins/manager.js";
import { startHttpApi } from "./http_api.js";
import {
  clearRestartNotifyChatId,
  getRestartNotifyChatId,
  initDatabase,
  setRuntimeInfo,
} from "./store/db.js";
import { InboundMessage } from "./types.js";
import { logRuntimeStart } from "./runtime_log.js";

class PerChatQueue {
  private queues = new Map<string, InboundMessage[]>();
  private processing = new Set<string>();

  constructor(private handler: (msg: InboundMessage) => Promise<void>) {}

  enqueue(msg: InboundMessage): void {
    const list = this.queues.get(msg.chatId) || [];
    list.push(msg);
    this.queues.set(msg.chatId, list);
    if (!this.processing.has(msg.chatId)) {
      void this.processNext(msg.chatId);
    }
  }

  private async processNext(chatId: string): Promise<void> {
    const list = this.queues.get(chatId);
    if (!list || list.length === 0) {
      this.processing.delete(chatId);
      return;
    }

    this.processing.add(chatId);
    const msg = list.shift();
    if (!msg) {
      this.processing.delete(chatId);
      return;
    }

    try {
      await this.handler(msg);
    } catch (err) {
      logger.error({ err }, "Message handler failed");
    } finally {
      setImmediate(() => this.processNext(chatId));
    }
  }
}

async function main(): Promise<void> {
  initDatabase();
  logger.info("Database initialized");
  const startedAt = new Date().toISOString();
  setRuntimeInfo(process.pid, startedAt);
  logRuntimeStart(process.pid, startedAt);
  startHttpApi();
  const pluginManager = getSharedPluginManager({ sendMessage: sendFeishuMessage });
  void pluginManager.loadEnabled();

  if (!FEISHU_RTM_ENABLED) {
    logger.error("FEISHU_RTM_ENABLED is false; nothing to run.");
    process.exit(1);
  }

  if (!FEISHU_BOT_NAME && !FEISHU_BOT_OPEN_ID) {
    logger.warn("FEISHU_BOT_NAME/FEISHU_BOT_OPEN_ID not set; group mention detection may fail.");
  }

  const rtm = new FeishuRtmClient();
  const queue = new PerChatQueue(async (msg) => {
    await handleInbound(msg, {
      sendMessage: sendFeishuMessage,
    });
  });

  rtm.on("message", (msg: InboundMessage) => {
    void handleInboundFast(msg, { sendMessage: sendFeishuMessage }).then((handled) => {
      if (handled) return;
      queue.enqueue(msg);
    });
  });

  rtm.on("connected", () => {
    logger.info("Feishu RTM ready");
    void notifyRestart();
  });

  await rtm.connect();
}

async function notifyRestart(): Promise<void> {
  const chatId = getRestartNotifyChatId();
  if (!chatId) return;
  try {
    await sendFeishuMessage(chatId, "服务已重启。");
    clearRestartNotifyChatId();
  } catch (err) {
    logger.warn({ err }, "Failed to send restart notification");
  }
}

main().catch((err) => {
  logger.error({ err }, "Fatal error");
  process.exit(1);
});
