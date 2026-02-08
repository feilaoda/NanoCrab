import { FEISHU_BOT_NAME, FEISHU_BOT_OPEN_ID, FEISHU_RTM_ENABLED } from "./config.js";
import { sendFeishuMessage } from "./feishu/api.js";
import { FeishuRtmClient } from "./feishu/rtm.js";
import { logger } from "./logger.js";
import { handleInbound } from "./router.js";
import { initDatabase } from "./store/db.js";
import { InboundMessage } from "./types.js";

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
    queue.enqueue(msg);
  });

  rtm.on("connected", () => {
    logger.info("Feishu RTM ready");
  });

  await rtm.connect();
}

main().catch((err) => {
  logger.error({ err }, "Fatal error");
  process.exit(1);
});
