import { MARKET_CACHE_TTL_MS, MARKET_REQUEST_GAP_MS } from "../../config.js";
import { AlphaVantageProvider } from "./providers/alphavantage.js";
import { MarketQuote } from "./provider.js";

const provider = new AlphaVantageProvider();
const INDEX_ALIASES = new Map<string, string>([
  ["上证", "000001.SS"],
  ["沪指", "000001.SS"],
  ["上证指数", "000001.SS"],
  ["深证", "399001.SZ"],
  ["深成指", "399001.SZ"],
  ["深证成指", "399001.SZ"],
  ["创业板", "399006.SZ"],
  ["创业板指", "399006.SZ"],
  ["科创50", "000688.SS"],
  ["科创板50", "000688.SS"],
  ["科创50ETF-华夏", "588000.SS"],
  ["科创50ETF华夏", "588000.SS"],
  ["科创50ETF 华夏", "588000.SS"],
  ["科创50ETF-易方达", "588050.SS"],
  ["科创50ETF易方达", "588050.SS"],
  ["科创50ETF 易方达", "588050.SS"],
  ["科创50ETF-华泰柏瑞", "588080.SS"],
  ["科创50ETF华泰柏瑞", "588080.SS"],
  ["科创50ETF 华泰柏瑞", "588080.SS"],
  ["科创50ETF-嘉实", "588090.SS"],
  ["科创50ETF嘉实", "588090.SS"],
  ["科创50ETF 嘉实", "588090.SS"],
  ["科创50ETF", "588000.SS"],
  ["上证50", "000016.SS"],
  ["沪深300", "000300.SS"],
  ["中证500", "000905.SS"],
  ["国企指数", "^HSCE"],
  ["恒生", "^HSI"],
  ["恒生指数", "^HSI"],
  ["恒指", "^HSI"],
  ["HSI", "^HSI"],
  ["HSCEI", "^HSCE"],
]);
const INDEX_ALIAS_UPPER = new Map<string, string>(
  Array.from(INDEX_ALIASES.entries()).map(([alias, symbol]) => [alias.toUpperCase(), symbol]),
);
const cache = new Map<string, { quote: MarketQuote; fetchedAt: number }>();
const inFlight = new Map<string, Promise<MarketQuote>>();
let lastRequestAt = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function normalizeMarketSymbol(input: string): string {
  const raw = input.trim();
  if (!raw) return "";
  const upper = raw.toUpperCase();
  const alias = INDEX_ALIASES.get(raw) || INDEX_ALIAS_UPPER.get(upper);
  if (alias) return alias;

  if (upper.includes(".") || upper.startsWith("^")) {
    return upper;
  }

  if (/^(SH|SZ)\d{6}$/.test(upper)) {
    const suffix = upper.startsWith("SH") ? "SS" : "SZ";
    return `${upper.slice(2)}.${suffix}`;
  }

  if (/^\d{6}$/.test(upper)) {
    const prefix = upper[0];
    if (prefix === "6" || prefix === "9") {
      return `${upper}.SS`;
    }
    if (prefix === "0" || prefix === "2" || prefix === "3") {
      return `${upper}.SZ`;
    }
    return upper;
  }

  if (/^\d{1,5}$/.test(upper)) {
    const padded = upper.padStart(4, "0");
    return `${padded}.HK`;
  }

  return upper;
}

export function findMarketSymbolInText(text: string): string | null {
  const raw = text.trim();
  if (!raw) return null;
  const upper = raw.toUpperCase();

  for (const [alias, symbol] of INDEX_ALIASES.entries()) {
    if (raw.includes(alias)) return symbol;
  }
  for (const [alias, symbol] of INDEX_ALIAS_UPPER.entries()) {
    if (upper.includes(alias)) return symbol;
  }

  const shsz = upper.match(/(SH|SZ)\d{6}/);
  if (shsz?.[0]) return normalizeMarketSymbol(shsz[0]);

  const six = upper.match(/(?<!\d)\d{6}(?!\d)/);
  if (six?.[0]) return normalizeMarketSymbol(six[0]);

  const hkSuffix = upper.match(/(?<!\d)\d{1,5}\.HK(?!\d)/);
  if (hkSuffix?.[0]) return normalizeMarketSymbol(hkSuffix[0]);

  if (/(港股|港股市场|HK)/i.test(raw)) {
    const hk = upper.match(/(?<!\d)\d{1,5}(?!\d)/);
    if (hk?.[0]) return normalizeMarketSymbol(hk[0]);
  }

  return null;
}

export function isMarketIntent(text: string): boolean {
  return /股票|ETF|指数|行情|价格|现价|报价|点位|多少|涨跌|最新|收盘|开盘/i.test(text);
}

function formatNumber(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return "-";
  return value.toFixed(digits);
}

function formatSigned(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return "-";
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${value.toFixed(digits)}`;
}

export function formatMarketQuote(quote: MarketQuote): string {
  const price = formatNumber(quote.price, 2);
  const change = formatSigned(quote.change, 2);
  const pct = formatSigned(quote.changePercent, 2);
  return `【${quote.symbol}】 ${price} (${change}, ${pct}%) ${quote.timestamp}`;
}

async function fetchQuote(symbol: string): Promise<MarketQuote> {
  const now = Date.now();
  const waitMs = MARKET_REQUEST_GAP_MS - (now - lastRequestAt);
  if (waitMs > 0) {
    await sleep(waitMs);
  }
  lastRequestAt = Date.now();
  return provider.getQuote(symbol);
}

export async function getMarketQuote(
  rawSymbol: string,
  opts?: { maxAgeMs?: number },
): Promise<MarketQuote> {
  const symbol = normalizeMarketSymbol(rawSymbol);
  if (!symbol) {
    throw new Error("请输入标的代码");
  }

  const maxAgeMs = opts?.maxAgeMs ?? MARKET_CACHE_TTL_MS;
  const cached = cache.get(symbol);
  const now = Date.now();
  if (cached && now - cached.fetchedAt <= maxAgeMs) {
    return cached.quote;
  }

  const pending = inFlight.get(symbol);
  if (pending) {
    return pending;
  }

  const promise = (async () => {
    const quote = await fetchQuote(symbol);
    cache.set(symbol, { quote, fetchedAt: Date.now() });
    return quote;
  })().finally(() => {
    inFlight.delete(symbol);
  });

  inFlight.set(symbol, promise);
  return promise;
}
