// Yahoo Finance v8 chart endpoint — public, no key required.
// https://query1.finance.yahoo.com/v8/finance/chart/AAPL
// Stable for our needs (last price, prev close, currency). v7 quote endpoint
// requires a crumb cookie since 2023, v8 chart does not.

import { safeErr } from '../utils/safeErr.js';

const UA = 'Mozilla/5.0 (compatible; market-pulse/0.1)';

export async function fetchYahooQuote(symbol, { log, timeoutMs = 5_000 } = {}) {
  const sym = symbol.toUpperCase();
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort('timeout'), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      headers: { 'User-Agent': UA, Accept: 'application/json' },
    });
    if (!res.ok) {
      log?.debug({ sym, status: res.status }, 'yahoo quote failed');
      return null;
    }
    const json = await res.json();
    const meta = json?.chart?.result?.[0]?.meta;
    const price = Number(meta?.regularMarketPrice);
    if (!Number.isFinite(price) || price <= 0) {
      log?.debug({ sym, err: json?.chart?.error }, 'yahoo quote: no price');
      return null;
    }
    const previousClose = Number(meta?.previousClose);
    const changeAbs = Number.isFinite(previousClose) ? price - previousClose : undefined;
    const changePct = Number.isFinite(previousClose) && previousClose > 0
      ? (price - previousClose) / previousClose * 100
      : undefined;

    return {
      symbol: meta.symbol || sym,
      type: 'stock',
      price,
      previousClose: Number.isFinite(previousClose) ? previousClose : undefined,
      changeAbs,
      changePct,
      currency: meta.currency || 'USD',
      exchange: meta.exchangeName,
      source: 'yahoo',
      fetchedAt: new Date().toISOString(),
    };
  } catch (e) {
    log?.debug({ sym, err: safeErr(e) }, 'yahoo quote errored');
    return null;
  } finally {
    clearTimeout(timer);
  }
}
