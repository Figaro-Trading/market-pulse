// Yahoo Finance v8 chart endpoint — used here for stock series. Public, no key.
// https://query1.finance.yahoo.com/v8/finance/chart/AAPL?range=1d&interval=1m
//
// Response shape:
//   chart.result[0].timestamp:  [unix sec, …]
//   chart.result[0].indicators.quote[0].close: [number|null, …]
// Holes in `close` (markets closed, after-hours gaps) come back as null —
// we drop those points rather than carrying forward a stale price.

import { safeErr } from '../../utils/safeErr.js';

const UA = 'Mozilla/5.0 (compatible; market-pulse/0.1)';

export async function fetchYahooSeries(symbol, { range, interval, points, log, timeoutMs = 6_000 } = {}) {
  const sym = symbol.toUpperCase();
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}`
    + `?range=${encodeURIComponent(range)}&interval=${encodeURIComponent(interval)}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort('timeout'), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      headers: { 'User-Agent': UA, Accept: 'application/json' },
    });
    if (!res.ok) {
      log?.debug({ sym, status: res.status }, 'yahoo series failed');
      return null;
    }
    const json = await res.json();
    const r = json?.chart?.result?.[0];
    const ts = r?.timestamp;
    const closes = r?.indicators?.quote?.[0]?.close;
    if (!Array.isArray(ts) || !Array.isArray(closes) || ts.length !== closes.length) {
      log?.debug({ sym }, 'yahoo series: malformed payload');
      return null;
    }
    const out = [];
    for (let i = 0; i < ts.length; i++) {
      const c = closes[i];
      if (typeof c === 'number' && Number.isFinite(c) && c > 0) {
        out.push([ts[i], c]);
      }
    }
    if (out.length === 0) return null;
    return {
      symbol: r.meta?.symbol || sym,
      type: 'stock',
      currency: r.meta?.currency || 'USD',
      points: out.slice(-points),
      source: 'yahoo',
    };
  } catch (e) {
    log?.debug({ sym, err: safeErr(e) }, 'yahoo series errored');
    return null;
  } finally {
    clearTimeout(timer);
  }
}
