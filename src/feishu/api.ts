import * as Lark from "@larksuiteoapi/node-sdk";

import { logger } from "../logger.js";
import { getSdkBaseConfig } from "./sdk.js";

let larkClient: Lark.Client | null = null;

function getClient(): Lark.Client {
  if (!larkClient) {
    larkClient = new Lark.Client(getSdkBaseConfig());
  }
  return larkClient;
}

export async function sendFeishuMessage(chatId: string, text: string): Promise<void> {
  const client = getClient();
  const res = await client.im.v1.message.create({
    params: { receive_id_type: "chat_id" },
    data: {
      receive_id: chatId,
      msg_type: "text",
      content: JSON.stringify({ text }),
    },
  });

  if (!res || res.code !== 0) {
    logger.error({ code: res?.code, msg: res?.msg }, "Failed to send Feishu message");
    return;
  }

  logger.info({ chatId, length: text.length }, "Feishu message sent");
}
