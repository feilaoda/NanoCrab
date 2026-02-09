export type MarketQuote = {
  symbol: string;
  price: number;
  change: number;
  changePercent: number;
  timestamp: string;
  source: string;
};

export interface MarketProvider {
  getQuote(symbol: string): Promise<MarketQuote>;
}
