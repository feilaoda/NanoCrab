import { MARKET_ALPHA_VANTAGE_API_KEY } from "../../../config.js";
import { MarketProvider, MarketQuote } from "../provider.js";

const BASE_URL = "https://www.alphavantage.co/query";

type AlphaQuotePayload = Record<string, string>;

type AlphaResponse = {
  "Global Quote"?: AlphaQuotePayload;
  Note?: string;
  "Error Message"?: string;
};

export class AlphaVantageProvider implements MarketProvider {
  private apiKey: string;

  constructor(apiKey = MARKET_ALPHA_VANTAGE_API_KEY) {
    this.apiKey = apiKey;
  }

  async getQuote(symbol: string): Promise<MarketQuote> {
    if (!this.apiKey) {
      throw new Error("未配置 MARKET_ALPHA_VANTAGE_API_KEY");
    }

    const url = `${BASE_URL}?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(symbol)}&apikey=${this.apiKey}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`请求失败：${res.status}`);
    }

    const data = (await res.json()) as AlphaResponse;
    if (data.Note) {
      throw new Error("请求过于频繁，已触发限频");
    }
    if (data["Error Message"]) {
      throw new Error("未找到该标的");
    }

    const quote = data["Global Quote"] || {};
    const price = Number(quote["05. price"] ?? "");
    if (!Number.isFinite(price)) {
      throw new Error("行情数据为空");
    }
    const change = Number(quote["09. change"] ?? "0");
    const changePercent = Number(String(quote["10. change percent"] ?? "0").replace("%", ""));
    const timestamp = quote["07. latest trading day"] || new Date().toISOString();
    const resolvedSymbol = quote["01. symbol"] || symbol;

    return {
      symbol: resolvedSymbol,
      price,
      change: Number.isFinite(change) ? change : 0,
      changePercent: Number.isFinite(changePercent) ? changePercent : 0,
      timestamp,
      source: "alphavantage",
    };
  }
}
