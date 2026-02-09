import { logger } from "../logger.js";
import { listMarketSubscriptionsByInterval } from "../store/market.js";
import { formatMarketQuote, getMarketQuote } from "../tools/market/service.js";

export type MarketScheduler = {
  stop: () => void;
};

const INTERVALS = [
  { label: "1m", ms: 60_000 },
  { label: "5m", ms: 300_000 },
  { label: "15m", ms: 900_000 },
];

export function startMarketScheduler(
  sendMessage: (chatId: string, text: string) => Promise<void>,
): MarketScheduler {
  const timers: NodeJS.Timeout[] = [];

  for (const interval of INTERVALS) {
    const tick = () => void runInterval(interval.label, interval.ms, sendMessage);
    timers.push(setInterval(tick, interval.ms));
    setTimeout(tick, 3_000);
  }

  return {
    stop: () => {
      for (const timer of timers) {
        clearInterval(timer);
      }
    },
  };
}

async function runInterval(
  interval: string,
  intervalMs: number,
  sendMessage: (chatId: string, text: string) => Promise<void>,
): Promise<void> {
  const subs = listMarketSubscriptionsByInterval(interval);
  if (subs.length === 0) return;

  const cacheMs = Math.max(10_000, intervalMs - 5_000);
  const symbolMap = new Map<string, Set<string>>();
  for (const sub of subs) {
    if (!sub.enabled) continue;
    const list = symbolMap.get(sub.symbol) || new Set<string>();
    list.add(sub.chatId);
    symbolMap.set(sub.symbol, list);
  }

  for (const [symbol, chatIds] of symbolMap.entries()) {
    try {
      const quote = await getMarketQuote(symbol, { maxAgeMs: cacheMs });
      const text = `订阅(${interval}) ${formatMarketQuote(quote)}`;
      for (const chatId of chatIds) {
        try {
          await sendMessage(chatId, text);
        } catch (err) {
          logger.warn({ err, chatId, symbol, interval }, "Market notify failed");
        }
      }
    } catch (err) {
      logger.warn({ err, symbol, interval }, "Market fetch failed");
    }
  }
}
