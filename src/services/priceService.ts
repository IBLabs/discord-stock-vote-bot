import { env } from "../env.js";

const MOCK_PRICES = new Map<string, number>([
  ["AAPL", 190],
  ["MSFT", 420],
  ["NVDA", 900],
]);

const PRICE_CACHE_TTL_MS = 5 * 60 * 1000;

type FinnhubQuoteResponse = {
  c?: number;
  d?: number;
  dp?: number;
  h?: number;
  l?: number;
  o?: number;
  pc?: number;
};

type FinnhubCandleResponse = {
  c?: number[];
  s?: string;
  t?: number[];
};

export type PriceQuote = {
  symbol: string;
  price: number;
  source: "finnhub" | "mock";
  change: number | null;
  percentChange: number | null;
  previousClose: number | null;
  fetchedAt: Date;
};

export type PriceTrend = {
  symbol: string;
  startPrice: number;
  endPrice: number;
  absoluteChange: number;
  percentChange: number;
  periodDays: number;
  fetchedAt: Date;
};

const priceCache = new Map<
  string,
  {
    quote: PriceQuote;
    expiresAt: number;
  }
>();

export async function getCurrentPrice(symbol: string) {
  return (await getPriceQuote(symbol)).price;
}

export async function getPriceQuote(symbol: string): Promise<PriceQuote> {
  const normalizedSymbol = symbol.trim().toUpperCase();
  const cached = priceCache.get(normalizedSymbol);

  if (cached && cached.expiresAt > Date.now()) {
    return cached.quote;
  }

  const quote =
    (await getFinnhubQuote(normalizedSymbol)) ?? getMockQuote(normalizedSymbol);

  if (!quote) {
    throw new Error(`No price available for ${normalizedSymbol}.`);
  }

  priceCache.set(normalizedSymbol, {
    quote,
    expiresAt: Date.now() + PRICE_CACHE_TTL_MS,
  });

  return quote;
}

export async function getThirtyDayPriceTrend(
  symbol: string,
): Promise<PriceTrend | null> {
  if (!env.FINNHUB_API_KEY) return null;

  try {
    const url = new URL("https://finnhub.io/api/v1/stock/candle");
    url.searchParams.set("symbol", symbol.trim().toUpperCase());
    url.searchParams.set("resolution", "D");
    url.searchParams.set(
      "from",
      Math.floor((Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000).toString(),
    );
    url.searchParams.set("to", Math.floor(Date.now() / 1000).toString());
    url.searchParams.set("token", env.FINNHUB_API_KEY);

    const response = await fetch(url);

    if (!response.ok) return null;

    const data = (await response.json()) as FinnhubCandleResponse;

    if (data.s !== "ok" || !Array.isArray(data.c) || data.c.length < 2) {
      return null;
    }

    const startPrice = data.c[0];
    const endPrice = data.c[data.c.length - 1];

    if (typeof startPrice !== "number" || typeof endPrice !== "number") {
      return null;
    }

    const absoluteChange = endPrice - startPrice;
    const percentChange =
      startPrice === 0 ? 0 : (absoluteChange / startPrice) * 100;

    return {
      symbol: symbol.trim().toUpperCase(),
      startPrice,
      endPrice,
      absoluteChange,
      percentChange,
      periodDays: 30,
      fetchedAt: new Date(),
    };
  } catch {
    return null;
  }
}

async function getFinnhubQuote(symbol: string): Promise<PriceQuote | null> {
  if (!env.FINNHUB_API_KEY) return null;

  try {
    const url = new URL("https://finnhub.io/api/v1/quote");
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("token", env.FINNHUB_API_KEY);

    const response = await fetch(url);

    if (!response.ok) return null;

    const data = (await response.json()) as FinnhubQuoteResponse;

    if (typeof data.c !== "number" || data.c <= 0) return null;

    return {
      symbol,
      price: data.c,
      source: "finnhub",
      change: typeof data.d === "number" ? data.d : null,
      percentChange: typeof data.dp === "number" ? data.dp : null,
      previousClose: typeof data.pc === "number" ? data.pc : null,
      fetchedAt: new Date(),
    };
  } catch {
    return null;
  }
}

function getMockQuote(symbol: string): PriceQuote | null {
  const price = MOCK_PRICES.get(symbol);

  if (!price) {
    return null;
  }

  return {
    symbol,
    price,
    source: "mock",
    change: null,
    percentChange: null,
    previousClose: null,
    fetchedAt: new Date(),
  };
}
