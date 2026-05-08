// Coinbase Exchange (legacy Pro) candles — public, no auth.
// https://api.exchange.coinbase.com/products/{product_id}/candles
//
// Granularities allowed: 60, 300, 900, 3600, 21600, 86400 (sec).
// Returns [[time, low, high, open, close, volume], …] sorted DESC, max 300.

import { safeErr } from '../../utils/safeErr.js';

const URL_BASE = 'https://api.exchange.coinbase.com';

export async function fetchCoinbaseSeries(base, quote, { granularitySec, points, log, timeoutMs = 6_000 } = {}) {
  const pair = `${base.toUpperCase()}-${quote.toUpperCase()}`;
  const url = `${URL_BASE}/products/${pair}/candles?granularity=${granularitySec}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort('timeout'), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      log?.debug({ pair, status: res.status }, 'coinbase series failed');
      return null;
    }
    const json = await res.json();
    if (!Array.isArray(json) || json.length === 0) return null;
    // Sort ASC (Coinbase returns DESC), keep [t (sec), close] only,
    // then take the freshest `points` entries.
    const asc = json
      .map(row => [Number(row[0]), Number(row[4])])
      .filter(([t, c]) => Number.isFinite(t) && Number.isFinite(c) && c > 0)
      .sort((a, b) => a[0] - b[0]);
    const trimmed = asc.slice(-points);
    if (trimmed.length === 0) return null;
    return {
      symbol: pair,
      type: 'crypto',
      currency: quote.toUpperCase(),
      points: trimmed,
      source: 'coinbase',
    };
  } catch (e) {
    log?.debug({ pair, err: safeErr(e) }, 'coinbase series errored');
    return null;
  } finally {
    clearTimeout(timer);
  }
}
