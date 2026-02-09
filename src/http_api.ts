import http from "http";
import { logger } from "./logger.js";
import { sendFeishuMessage } from "./feishu/api.js";
import { HTTP_API_ENABLED, HTTP_API_HOST, HTTP_API_PORT, HTTP_API_TOKEN } from "./config.js";

type PushPayload = {
  chatId?: string;
  text?: string;
};

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk.toString();
      if (data.length > 1024 * 1024) {
        req.destroy();
        reject(new Error("payload too large"));
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function parseAuth(req: http.IncomingMessage): string {
  const auth = String(req.headers.authorization || "");
  if (!auth) return "";
  const lower = auth.toLowerCase();
  if (lower.startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  return auth.trim();
}

function json(res: http.ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function handlePush(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (req.method !== "POST") {
    json(res, 405, { ok: false, error: "method_not_allowed" });
    return;
  }
  if (HTTP_API_TOKEN) {
    const token = parseAuth(req);
    if (!token || token !== HTTP_API_TOKEN) {
      json(res, 401, { ok: false, error: "unauthorized" });
      return;
    }
  }
  let body = "";
  try {
    body = await readBody(req);
  } catch (err) {
    json(res, 413, { ok: false, error: "payload_too_large" });
    return;
  }
  let payload: PushPayload = {};
  try {
    payload = JSON.parse(body || "{}") as PushPayload;
  } catch {
    json(res, 400, { ok: false, error: "invalid_json" });
    return;
  }
  const chatId = String(payload.chatId || "").trim();
  const text = String(payload.text || "").trim();
  if (!chatId || !text) {
    json(res, 400, { ok: false, error: "chatId_or_text_missing" });
    return;
  }
  try {
    await sendFeishuMessage(chatId, text);
    json(res, 200, { ok: true });
  } catch (err) {
    logger.error({ err }, "HTTP push failed");
    json(res, 500, { ok: false, error: "send_failed" });
  }
}

export function startHttpApi(): void {
  if (!HTTP_API_ENABLED) return;
  const server = http.createServer((req, res) => {
    const url = req.url || "/";
    if (url === "/health") {
      json(res, 200, { ok: true });
      return;
    }
    if (url === "/api/push") {
      void handlePush(req, res);
      return;
    }
    json(res, 404, { ok: false, error: "not_found" });
  });
  server.listen(HTTP_API_PORT, HTTP_API_HOST, () => {
    logger.info(
      { host: HTTP_API_HOST, port: HTTP_API_PORT, token: HTTP_API_TOKEN ? "set" : "unset" },
      "HTTP API listening",
    );
  });
}
