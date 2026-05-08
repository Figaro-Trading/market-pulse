// Multi-symbol price series orchestrator. Routes each symbol to its backend
// (Coinbase candles for crypto, Yahoo chart for stocks), caches per
// (symbol, window) tuple, and resolves errors per-symbol so one bad ticker
// doesn't poison the whole batch.

import { detectAsset } from '../asset.js';
import { fetchCoinbaseSeries } from './coinbase.js';
import { fetchYahooSeries } from './yahoo.js';

// Window → upstream parameters and target point count.
// 60m  ≈ minute candles for the past hour
// 4h   ≈ 5-minute candles for the trading day
// 1d   ≈ hourly candles for the last few sessions
// 1w   ≈ 6-hour candles for the last week
const WINDOWS = {
  '60m': { points: 60, coinbaseGran: 60,    yahoo: { range: '1d',  interval: '1m' }, cacheTtlMs:        60_000 },
  '4h':  { points: 48, coinbaseGran: 300,   yahoo: { range: '1d',  interval: '5m' }, cacheTtlMs:    5 * 60_000 },
  '1d':  { points: 24, coinbaseGran: 3600,  yahoo: { range: '5d',  interval: '1h' }, cacheTtlMs:   30 * 60_000 },
  '1w':  { points: 28, coinbaseGran: 21600, yahoo: { range: '1mo', interval: '1d' }, cacheTtlMs: 6 * 60 * 60_000 },
};

export const SUPPORTED_WINDOWS = Object.keys(WINDOWS);

const _cache = new Map();      // `${type}:${symbol}:${window}` → { value, expiresAt }
const _inflight = new Map();   // same key → Promise (request coalescing)
let _log = null;

export function init({ log }) {
  _log = log?.child ? log.child({ module: 'quotes-series' }) : log;
}

function cacheGet(key) {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    _cache.delete(key);
    return null;
  }
  return entry.value;
}

function cacheSet(key, value, ttlMs) {
  _cache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

async function fetchOne(symbol, window) {
  const cfg = WINDOWS[window];
  const asset = detectAsset(symbol);
  if (!asset) return { error: 'invalid_symbol' };

  const key = asset.type === 'crypto'
    ? `crypto:${asset.base}-${asset.quote || 'USD'}:${window}`
    : `stock:${asset.symbol}:${window}`;

  const cached = cacheGet(key);
  if (cached) return cached;
  if (_inflight.has(key)) return _inflight.get(key);

  const p = (async () => {
    try {
      let result = null;
      if (asset.type === 'crypto') {
        result = await fetchCoinbaseSeries(asset.base, asset.quote || 'USD', {
          granularitySec: cfg.coinbaseGran,
          points: cfg.points,
          log: _log,
        });
      } else {
        result = await fetchYahooSeries(asset.symbol, {
          range: cfg.yahoo.range,
          interval: cfg.yahoo.interval,
          points: cfg.points,
          log: _log,
        });
      }
      const value = result || { error: 'not_found' };
      cacheSet(key, value, cfg.cacheTtlMs);
      return value;
    } finally {
      _inflight.delete(key);
    }
  })();
  _inflight.set(key, p);
  return p;
}

export async function getSeries(symbols, window) {
  if (!WINDOWS[window]) return { error: 'invalid_window' };
  const results = await Promise.all(symbols.map(s => fetchOne(s, window)));
  const series = {};
  symbols.forEach((s, i) => { series[s] = results[i]; });
  return {
    window,
    interval: window === '60m' ? '1m' : window === '4h' ? '5m' : window === '1d' ? '1h' : '6h',
    fetchedAt: new Date().toISOString(),
    series,
  };
}

export function status() {
  return {
    cacheSize: _cache.size,
    inflight: _inflight.size,
    windows: SUPPORTED_WINDOWS,
  };
}
