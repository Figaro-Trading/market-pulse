// Nasdaq public quote API — used as fallback when Yahoo is unavailable.
// https://api.nasdaq.com/api/quote/AAPL/info?assetclass=stocks
//
// Returns prices as strings with $/,/% — same parsing logic as the original
// BigBeluga worker handled. Bid/ask may be missing outside trading hours; we
// synthesize a tight spread around lastSalePrice in that case to keep the
// shape consistent.

import { safeErr } from '../utils/safeErr.js';

function parseNumber(s) {
  if (s == null) return null;
  const t = String(s).trim().replace(/\$/g, '').replace(/,/g, '').replace(/%/g, '');
  if (!t || t.toUpperCase() === 'N/A') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export async function fetchNasdaqQuote(symbol, { log, timeoutMs = 5_000 } = {}) {
  const sym = symbol.toUpperCase();
  const url = `https://api.nasdaq.com/api/quote/${encodeURIComponent(sym)}/info?assetclass=stocks`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort('timeout'), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      headers: { Accept: 'application/json, text/plain, */*' },
    });
    if (!res.ok) {
      log?.debug({ sym, status: res.status }, 'nasdaq quote failed');
      return null;
    }
    const json = await res.json();
    const primary = json?.data?.primaryData;
    if (!primary) return null;

    const last = parseNumber(primary.lastSalePrice);
    let bid = parseNumber(primary.bidPrice);
    let ask = parseNumber(primary.askPrice);
    let bidSize = parseNumber(primary.bidSize);
    let askSize = parseNumber(primary.askSize);

    if (!Number.isFinite(last) || last <= 0) return null;

    // Out-of-session: synthesize a 2 bps spread around last price
    if (((bid ?? 0) <= 0 || (ask ?? 0) <= 0)) {
      const spread = Math.max(0.0002 * last, 0.01);
      bid = Math.max(last - spread / 2, 1e-4);
      ask = last + spread / 2;
    }
    if (!Number.isFinite(bidSize) || (bidSize ?? 0) <= 0) bidSize = 1;
    if (!Number.isFinite(askSize) || (askSize ?? 0) <= 0) askSize = 1;

    const changeAbs = parseNumber(primary.netChange);
    const changePct = parseNumber(primary.percentageChange);

    return {
      symbol: sym,
      type: 'stock',
      price: last,
      bid,
      ask,
      bidSize,
      askSize,
      changeAbs: changeAbs ?? undefined,
      changePct: changePct ?? undefined,
      currency: 'USD',
      source: 'nasdaq',
      fetchedAt: new Date().toISOString(),
    };
  } catch (e) {
    log?.debug({ sym, err: safeErr(e) }, 'nasdaq quote errored');
    return null;
  } finally {
    clearTimeout(timer);
  }
}
