const MOCK_PRICES = new Map<string, number>([
  ["AAPL", 190],
  ["MSFT", 420],
  ["NVDA", 900],
]);

export function getCurrentPrice(symbol: string) {
  const normalizedSymbol = symbol.trim().toUpperCase();
  const price = MOCK_PRICES.get(normalizedSymbol);

  if (!price) {
    throw new Error(`No mocked price configured for ${normalizedSymbol}.`);
  }

  return price;
}
