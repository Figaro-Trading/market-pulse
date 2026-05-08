// Routes a user-supplied symbol to its backend type.
// Extracted from quotes/index.js so the series orchestrator can reuse it
// without creating an import cycle (series/index.js → quotes/index.js).
//
//   BTC, ETH, SOL, …                  → crypto BTC-USD
//   BTC-USD, BTC/USD, BTC_USD         → crypto BTC-USD
//   BTCUSD, BTCUSDT, BTCUSDC, BTCBUSD → crypto BTC-USD (we always quote in USD)
//   AAPL, TSLA, ^GSPC, BRK-B, …       → stock (Yahoo, Nasdaq fallback)

const KNOWN_CRYPTO = new Set([
  'BTC','ETH','SOL','XRP','DOGE','ADA','AVAX','DOT','LINK','LTC','BCH',
  'MATIC','POL','ARB','OP','APT','NEAR','ATOM','FIL','ETC','INJ','SUI',
  'TIA','SEI','TON','PEPE','SHIB','WLD','ORDI','AAVE','TRX','HBAR',
  'ALGO','XLM','EOS','XTZ','THETA','UNI','SAND','MANA','GRT','ICP',
  'USDT','USDC',
]);

export function detectAsset(rawSymbol) {
  const s = String(rawSymbol || '').trim().toUpperCase();
  if (!s) return null;

  // 1) Pure crypto ticker
  if (KNOWN_CRYPTO.has(s)) return { type: 'crypto', base: s, quote: 'USD' };

  // 2) Pair with separator
  for (const sep of ['-', '/', '_']) {
    if (s.includes(sep)) {
      const [base, q] = s.split(sep);
      if (KNOWN_CRYPTO.has(base)) {
        return { type: 'crypto', base, quote: q || 'USD' };
      }
    }
  }

  // 3) Suffixed pairs
  for (const suffix of ['USDT', 'USDC', 'BUSD', 'USD']) {
    if (s.endsWith(suffix) && s.length > suffix.length) {
      const base = s.slice(0, -suffix.length);
      if (KNOWN_CRYPTO.has(base)) {
        return { type: 'crypto', base, quote: suffix };
      }
    }
  }

  // 4) Default: stock ticker
  return { type: 'stock', symbol: s };
}
