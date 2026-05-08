// Coinbase public spot price endpoint — no auth, no quota in normal use.
// https://api.coinbase.com/v2/prices/{pair}/spot

import { safeErr } from '../utils/safeErr.js';

const fetchedNow = () => new Date().toISOString();

export async function fetchCoinbaseQuote(base, quote = 'USD', { log, timeoutMs = 5_000 } = {}) {
  const pair = `${base.toUpperCase()}-${quote.toUpperCase()}`;
  const url = `https://api.coinbase.com/v2/prices/${pair}/spot`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort('timeout'), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) {
      log?.debug({ pair, status: res.status }, 'coinbase quote failed');
      return null;
    }
    const json = await res.json();
    const price = parseFloat(json?.data?.amount);
    if (!Number.isFinite(price) || price <= 0) return null;
    return {
      symbol: pair,
      type: 'crypto',
      price,
      currency: quote.toUpperCase(),
      source: 'coinbase',
      fetchedAt: fetchedNow(),
    };
  } catch (e) {
    log?.debug({ pair, err: safeErr(e) }, 'coinbase quote errored');
    return null;
  } finally {
    clearTimeout(timer);
  }
}
