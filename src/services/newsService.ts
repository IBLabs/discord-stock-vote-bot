import { env } from "../env.js";

export type NewsArticle = {
  category: string;
  datetime: number;
  headline: string;
  id: number;
  image?: string | null;
  related?: string | null;
  source: string;
  summary?: string | null;
  url: string;
};

export type MorningNewsDigest = {
  general: NewsArticle[];
  companyNews: Record<string, NewsArticle[]>;
};

const DEFAULT_WATCHLIST = ["AAPL", "MSFT", "NVDA", "AMZN", "TSLA"];

export async function getMorningNewsDigest(symbols: string[]) {
  if (!env.FINNHUB_API_KEY) {
    return {
      general: [],
      companyNews: {},
    } satisfies MorningNewsDigest;
  }

  const trackedSymbols = Array.from(
    new Set(
      symbols.map((symbol) => symbol.trim().toUpperCase()).filter(Boolean),
    ),
  ).slice(0, 5);

  const activeSymbols =
    trackedSymbols.length > 0 ? trackedSymbols : DEFAULT_WATCHLIST;
  const today = new Date();
  const since = new Date(today);

  since.setDate(today.getDate() - 1);

  const [general, ...companyNewsEntries] = await Promise.all([
    fetchFinnhubNews(`/news?category=general`),
    ...activeSymbols.map(async (symbol) => {
      const articles = await fetchFinnhubNews(
        `/company-news?symbol=${encodeURIComponent(symbol)}&from=${formatDate(
          since,
        )}&to=${formatDate(today)}`,
      );

      return [symbol, articles] as const;
    }),
  ]);

  const companyNews = Object.fromEntries(
    companyNewsEntries.map(([symbol, articles]) => [
      symbol,
      articles.slice(0, 3),
    ]),
  );

  return {
    general: general.slice(0, 5),
    companyNews,
  } satisfies MorningNewsDigest;
}

function formatDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

async function fetchFinnhubNews(path: string) {
  const url = new URL(`https://finnhub.io/api/v1${path}`);
  url.searchParams.set("token", env.FINNHUB_API_KEY ?? "");

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Finnhub request failed with ${response.status}.`);
  }

  return (await response.json()) as NewsArticle[];
}
