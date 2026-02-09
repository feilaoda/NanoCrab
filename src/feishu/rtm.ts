import { EventEmitter } from "events";
import * as Lark from "@larksuiteoapi/node-sdk";

import {
  FEISHU_BOT_NAME,
  FEISHU_BOT_OPEN_ID,
  FEISHU_ENCRYPT_KEY,
  FEISHU_SDK_LOG_LEVEL,
} from "../config.js";
import { logger } from "../logger.js";
import { InboundMessage } from "../types.js";
import { getSdkBaseConfig } from "./sdk.js";

export class FeishuRtmClient extends EventEmitter {
  private wsClient: Lark.WSClient | null = null;

  async connect(): Promise<void> {
    if (this.wsClient) return;

    const dispatcher = new Lark.EventDispatcher({
      ...(FEISHU_ENCRYPT_KEY ? { encryptKey: FEISHU_ENCRYPT_KEY } : {}),
    }).register({
      "im.message.receive_v1": async (data) => {
        const inbound = this.parseInbound(data);
        if (inbound) {
          this.emit("message", inbound);
        }
      },
    });

    const baseConfig = getSdkBaseConfig();
    logger.info({ domain: baseConfig.domain }, "Feishu SDK domain");
    const loggerLevel = resolveLoggerLevel(FEISHU_SDK_LOG_LEVEL);
    this.wsClient = new Lark.WSClient({
      appId: baseConfig.appId,
      appSecret: baseConfig.appSecret,
      ...(baseConfig.domain ? { domain: baseConfig.domain } : {}),
      ...(loggerLevel !== undefined ? { loggerLevel } : {}),
    });

    this.wsClient.start({ eventDispatcher: dispatcher });
    logger.info("Feishu RTM (SDK) start requested");
    this.emit("connected");
  }

  async disconnect(): Promise<void> {
    if (!this.wsClient) return;
    const wsClient = this.wsClient;
    this.wsClient = null;

    const wsClientAny = wsClient as unknown as {
      stop?: () => Promise<void> | void;
      close?: () => Promise<void> | void;
    };

    if (typeof wsClientAny.stop === "function") {
      await wsClientAny.stop();
      return;
    }

    if (typeof wsClientAny.close === "function") {
      await wsClientAny.close();
    }
  }

  private parseInbound(event: any): InboundMessage | null {
    if (!event?.message || !event?.sender) return null;

    if (event.sender.sender_type && event.sender.sender_type !== "user") {
      return null;
    }

    const message = event.message;
    if (message.message_type !== "text") return null;

    const content = this.extractText(message.content);
    if (!content) return null;

    const chatId = message.chat_id as string;
    const isGroup = message.chat_type === "group";

    const mentions = message.mentions || event.mentions || [];
    const isMentioned = this.detectMention(content, mentions);

    const senderId =
      event.sender?.sender_id?.user_id ||
      event.sender?.sender_id?.open_id ||
      event.sender?.sender_id?.union_id ||
      "unknown";

    return {
      chatId,
      senderId,
      senderName: event.sender?.sender_id?.user_id || undefined,
      isGroup,
      isMentioned,
      text: content,
      timestamp: normalizeTimestamp(message.create_time),
      rawEvent: event,
    };
  }

  private extractText(content: string | undefined): string | null {
    if (!content) return null;
    try {
      const parsed = JSON.parse(content) as { text?: string };
      return parsed.text?.trim() || null;
    } catch {
      return null;
    }
  }

  private detectMention(text: string, mentions: any[]): boolean {
    if (FEISHU_BOT_OPEN_ID) {
      for (const mention of mentions) {
        const id = mention.open_id || mention.user_id || mention.id;
        if (id && id === FEISHU_BOT_OPEN_ID) return true;
      }
    }

    if (FEISHU_BOT_NAME) {
      if (text.includes(`@${FEISHU_BOT_NAME}`)) return true;
      for (const mention of mentions) {
        const name = mention.name || mention.user_name || mention.display_name;
        if (name && name === FEISHU_BOT_NAME) return true;
      }
    }

    return false;
  }
}

function resolveLoggerLevel(value: string): Lark.LoggerLevel | undefined {
  const level = value.trim().toLowerCase();
  if (!level) return undefined;
  switch (level) {
    case "debug":
      return Lark.LoggerLevel.debug;
    case "info":
      return Lark.LoggerLevel.info;
    case "warn":
    case "warning":
      return Lark.LoggerLevel.warn;
    case "error":
      return Lark.LoggerLevel.error;
    default:
      return undefined;
  }
}

function normalizeTimestamp(value: string | number | undefined): string {
  const raw = typeof value === "number" ? value : Number(value || NaN);
  if (!Number.isFinite(raw)) return new Date().toISOString();
  const ms = raw < 1_000_000_000_000 ? raw * 1000 : raw;
  return new Date(ms).toISOString();
}
