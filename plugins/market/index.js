import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";

function resolveModule(candidates) {
  for (const rel of candidates) {
    const full = path.join(process.cwd(), rel);
    if (fs.existsSync(full)) {
      return full;
    }
  }
  throw new Error(`market plugin load failed: ${candidates.join(", ")}`);
}

const servicePath = resolveModule([
  "dist/tools/market/service.js",
  "src/tools/market/service.ts",
]);
const storePath = resolveModule([
  "dist/store/market.js",
  "src/store/market.ts",
]);
const schedulerPath = resolveModule([
  "dist/scheduler/market.js",
  "src/scheduler/market.ts",
]);

const service = await import(pathToFileURL(servicePath).href);
const store = await import(pathToFileURL(storePath).href);
const scheduler = await import(pathToFileURL(schedulerPath).href);

const {
  findMarketSymbolInText,
  formatMarketQuote,
  getMarketQuote,
  isMarketIntent,
  normalizeMarketSymbol,
} = service;
const {
  addMarketSubscription,
  listMarketSubscriptions,
  logAudit,
  removeMarketSubscription,
} = store;
const { startMarketScheduler } = scheduler;

let marketScheduler = null;

function getSender(ctx) {
  if (typeof ctx?.sendMessageTo === "function") {
    return ctx.sendMessageTo.bind(ctx);
  }
  if (typeof ctx?.sendMessage === "function") {
    return (chatId, text) => {
      if (chatId === ctx.chatId) {
        ctx.sendMessage(text);
      }
    };
  }
  return () => {};
}

export function activate(ctx) {
  if (marketScheduler) return;
  const sendMessageTo = getSender(ctx);
  marketScheduler = startMarketScheduler(async (chatId, text) => {
    try {
      await sendMessageTo(chatId, text);
    } catch (err) {
      ctx?.log?.("warn", "market notify failed", { err, chatId });
    }
  });
  ctx?.log?.("info", "market plugin activated");
}

export function deactivate(ctx) {
  if (marketScheduler) {
    marketScheduler.stop();
    marketScheduler = null;
  }
  ctx?.log?.("info", "market plugin deactivated");
}

export async function onEvent(type, payload, ctx) {
  if (type !== "message_received") return false;
  const text = String(payload?.text || "").trim();
  if (!text) return false;

  const symbol = findMarketSymbolInText(text);
  if (!symbol) return false;
  if (!isMarketIntent(text) && text !== symbol) {
    return false;
  }

  logAudit(ctx.chatId, "market.auto", JSON.stringify({ symbol }));
  try {
    const quote = await getMarketQuote(symbol);
    ctx?.sendMessage?.(formatMarketQuote(quote));
  } catch (err) {
    ctx?.sendMessage?.(`行情获取失败：${String(err)}`);
  }
  return true;
}

export async function onCommand(cmd, args, ctx) {
  if (cmd === "market") {
    return handleMarketCommand(args, ctx);
  }
  if (cmd === "show") {
    return handleMarketCommand(["show", ...args], ctx);
  }
  if (cmd === "watch") {
    return handleMarketCommand(["watch", ...args], ctx);
  }
  ctx?.sendMessage?.(
    "用法：/show <symbol> | /market show <symbol> | /market watch add <symbol> --interval 5m",
  );
  return false;
}

function normalizeMarketInterval(value) {
  const raw = value.trim().toLowerCase();
  if (raw === "1" || raw === "1m") return "1m";
  if (raw === "5" || raw === "5m") return "5m";
  if (raw === "15" || raw === "15m") return "15m";
  return null;
}

function parseMarketInterval(args) {
  const idx = args.findIndex((item) => item === "--interval" || item === "-i");
  if (idx >= 0) {
    const value = args[idx + 1];
    if (!value) return { value: null, provided: true };
    return { value: normalizeMarketInterval(value), provided: true };
  }

  const direct = args.find((item) => normalizeMarketInterval(item) !== null);
  if (direct) {
    return { value: normalizeMarketInterval(direct), provided: true };
  }
  return { value: null, provided: false };
}

async function handleMarketCommand(args, ctx) {
  const sub = (args[0] || "help").toLowerCase();

  if (sub === "show") {
    const symbol = args[1];
    if (!symbol) {
      ctx?.sendMessage?.("用法：/market show <symbol>");
      return true;
    }
    const normalized = normalizeMarketSymbol(symbol);
    logAudit(ctx.chatId, "market.show", JSON.stringify({ symbol: normalized }));
    try {
      const quote = await getMarketQuote(normalized);
      ctx?.sendMessage?.(formatMarketQuote(quote));
    } catch (err) {
      ctx?.sendMessage?.(`行情获取失败：${String(err)}`);
    }
    return true;
  }

  if (sub === "watch") {
    const action = (args[1] || "list").toLowerCase();
    if (action === "list") {
      const subs = listMarketSubscriptions(ctx.chatId);
      if (subs.length === 0) {
        ctx?.sendMessage?.("暂无订阅。用法：/market watch add <symbol> --interval 5m");
        return true;
      }
      const lines = subs.map((subItem) => `- ${subItem.symbol} (${subItem.interval})`);
      ctx?.sendMessage?.(`当前订阅：\n${lines.join("\n")}`);
      return true;
    }

    if (action === "add") {
      const symbol = args[2];
      if (!symbol) {
        ctx?.sendMessage?.("用法：/market watch add <symbol> --interval 5m");
        return true;
      }
      const parsedInterval = parseMarketInterval(args.slice(3));
      if (parsedInterval.provided && !parsedInterval.value) {
        ctx?.sendMessage?.("仅支持间隔：1m / 5m / 15m");
        return true;
      }
      const interval = parsedInterval.value ?? "5m";
      const normalized = normalizeMarketSymbol(symbol);
      if (!normalized) {
        ctx?.sendMessage?.("请输入有效的标的代码。");
        return true;
      }
      const result = addMarketSubscription(ctx.chatId, normalized, interval);
      logAudit(ctx.chatId, "market.watch.add", JSON.stringify({ symbol: normalized, interval }));
      const note = result.created ? "已添加订阅" : "已更新订阅";
      ctx?.sendMessage?.(`${note}：${normalized}（${interval}）`);
      return true;
    }

    if (action === "remove") {
      const symbol = args[2];
      if (!symbol) {
        ctx?.sendMessage?.("用法：/market watch remove <symbol> [--interval 5m]");
        return true;
      }
      const parsedInterval = parseMarketInterval(args.slice(3));
      if (parsedInterval.provided && !parsedInterval.value) {
        ctx?.sendMessage?.("仅支持间隔：1m / 5m / 15m");
        return true;
      }
      const interval = parsedInterval.value ?? undefined;
      const normalized = normalizeMarketSymbol(symbol);
      const removed = removeMarketSubscription(ctx.chatId, normalized, interval);
      logAudit(ctx.chatId, "market.watch.remove", JSON.stringify({ symbol: normalized, interval }));
      if (removed === 0) {
        ctx?.sendMessage?.("未找到对应订阅。");
        return true;
      }
      const suffix = interval ? `（${interval}）` : "";
      ctx?.sendMessage?.(`已移除订阅：${normalized}${suffix}`);
      return true;
    }

    ctx?.sendMessage?.("用法：/market watch add|list|remove ...");
    return true;
  }

  if (sub === "list") {
    return handleMarketCommand(["watch", "list"], ctx);
  }

  ctx?.sendMessage?.(
    "用法：/market show <symbol> | /market watch add <symbol> --interval 5m | /market watch list | /market watch remove <symbol> [--interval 5m]",
  );
  return true;
}
