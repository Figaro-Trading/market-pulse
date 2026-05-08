// Bybit V5 tickers — single call returns funding + open interest + price for
// every linear perpetual. https://bybit-exchange.github.io/docs/v5/market/tickers
//
// Without a `symbol` filter, the response includes ~500 instruments. Bandwidth
// is small (few hundred KB) and the response is rate-limit-friendly (600 req/
// 5s per IP), so we just take the firehose every refresh cycle.

import { safeErr } from '../utils/safeErr.js';

const URL_LINEAR = 'https://api.bybit.com/v5/market/tickers?category=linear';

const num = (v) => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export async function fetchBybitLinearTickers({ log, timeoutMs = 10_000 } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort('timeout'), timeoutMs);
  try {
    const res = await fetch(URL_LINEAR, {
      signal: ac.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      log?.warn({ status: res.status }, 'bybit tickers fetch failed');
      return null;
    }
    const json = await res.json();
    if (json?.retCode !== 0 || !Array.isArray(json.result?.list)) {
      log?.warn({ retCode: json?.retCode, retMsg: json?.retMsg }, 'bybit tickers bad response');
      return null;
    }

    const fetchedAt = new Date().toISOString();
    const out = {};
    for (const t of json.result.list) {
      const sym = String(t.symbol || '').toUpperCase();
      if (!sym) continue;

      const lastPrice          = num(t.lastPrice);
      const markPrice          = num(t.markPrice);
      const indexPrice         = num(t.indexPrice);
      const openInterest       = num(t.openInterest);
      const openInterestValue  = num(t.openInterestValue);   // USD value
      const fundingRate        = num(t.fundingRate);          // decimal, e.g. 0.0001 = 0.01%
      const nextFundingTime    = num(t.nextFundingTime);
      const volume24h          = num(t.volume24h);
      const turnover24h        = num(t.turnover24h);
      const price24hPcnt       = num(t.price24hPcnt);

      // Skip rows with no price — usually delisted/ paused symbols.
      if (lastPrice == null || lastPrice <= 0) continue;

      out[sym] = {
        symbol: sym,
        lastPrice,
        markPrice,
        indexPrice,
        openInterest,
        openInterestValueUsd: openInterestValue,
        fundingRate,
        fundingRatePct: fundingRate != null ? fundingRate * 100 : null,
        nextFundingTime: nextFundingTime ? new Date(nextFundingTime).toISOString() : null,
        volume24h,
        turnover24hUsd: turnover24h,
        price24hPct: price24hPcnt != null ? price24hPcnt * 100 : null,
        source: 'bybit',
        fetchedAt,
      };
    }
    return out;
  } catch (e) {
    log?.warn({ err: safeErr(e) }, 'bybit tickers errored');
    return null;
  } finally {
    clearTimeout(timer);
  }
}
