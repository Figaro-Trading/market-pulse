import express from 'express';
import { fetchYahooQuote } from './yahoo.js';
import { fetchNasdaqQuote } from './nasdaq.js';
import { fetchCoinbaseQuote } from './coinbase.js';
import { detectAsset } from './asset.js';
import * as series from './series/index.js';
import { safeErr } from '../utils/safeErr.js';

// Module state.
let _log = null;
let _ttlMs = 10_000;
// Negative cache TTL — short enough to recover quickly when an upstream comes
// back, long enough to absorb a burst of failing lookups for the same symbol
// (which would otherwise hammer Yahoo/Nasdaq/Coinbase and amplify a 3rd-party
// outage into our own).
const NEG_TTL_MS = 2_000;
const _cache = new Map();      // symbol → { quote, expiresAt, negative? }
const _inflight = new Map();   // symbol → Promise (request coalescing)
const _stats = { hits: 0, misses: 0, errors: 0, requests: 0 };

// ── Cache helpers ─────────────────────────────────────────────────────────

// Returns `{ hit: bool, quote: any|null, negative: bool }`. A negative hit
// short-circuits the upstream lookup with a 404 — protecting Yahoo/Nasdaq/
// Coinbase from amplification when a symbol is unresolvable.
function cacheGet(key) {
  const entry = _cache.get(key);
  if (!entry) return { hit: false };
  if (entry.expiresAt <= Date.now()) {
    _cache.delete(key);
    return { hit: false };
  }
  return { hit: true, quote: entry.quote, negative: !!entry.negative };
}

function cacheSet(key, quote) {
  _cache.set(key, { quote, expiresAt: Date.now() + _ttlMs, negative: false });
}

function cacheSetNegative(key) {
  _cache.set(key, { quote: null, expiresAt: Date.now() + NEG_TTL_MS, negative: true });
}

// Light periodic prune to bound the cache map.
function prune() {
  const now = Date.now();
  for (const [k, v] of _cache) if (v.expiresAt <= now) _cache.delete(k);
}

// ── Public API ────────────────────────────────────────────────────────────

export function start({ log, config }) {
  _log = log.child({ module: 'quotes' });
  _ttlMs = Math.max(500, Number(config?.cacheTtlMs) || 10_000);
  setInterval(prune, _ttlMs * 5).unref?.();
  series.init({ log: _log });
  _log.info({ ttlMs: _ttlMs }, 'quotes module started');
}

export function status() {
  // Quotes are on-demand; staleness has no meaning here. Keep `stale: false`
  // so /readyz can use a uniform shape across modules.
  return {
    enabled: _log != null,
    stale: false,
    ttlMs: _ttlMs,
    cacheSize: _cache.size,
    inflight: _inflight.size,
    ...(_stats),
  };
}

async function fetchOne(symbol) {
  const asset = detectAsset(symbol);
  if (!asset) return null;

  if (asset.type === 'crypto') {
    return fetchCoinbaseQuote(asset.base, asset.quote, { log: _log });
  }

  // Stocks: try Yahoo then Nasdaq.
  const yahoo = await fetchYahooQuote(asset.symbol, { log: _log });
  if (yahoo) return yahoo;
  return fetchNasdaqQuote(asset.symbol, { log: _log });
}

export async function getQuote(symbol) {
  _stats.requests += 1;
  const key = String(symbol || '').trim().toUpperCase();
  if (!key) return null;

  const cached = cacheGet(key);
  if (cached.hit) {
    _stats.hits += 1;
    // Negative hit: tell the route to render a 404 without re-fetching.
    return cached.negative ? null : cached.quote;
  }
  _stats.misses += 1;

  // Coalesce concurrent requests for the same symbol.
  if (_inflight.has(key)) return _inflight.get(key);

  const p = (async () => {
    try {
      const quote = await fetchOne(key);
      if (quote) {
        cacheSet(key, quote);
      } else {
        cacheSetNegative(key);
        _stats.errors += 1;
      }
      return quote;
    } finally {
      _inflight.delete(key);
    }
  })();
  _inflight.set(key, p);
  return p;
}

// ── HTTP API ──────────────────────────────────────────────────────────────

// Symbol shape: BTC, BTCUSDT, BTC-USD, BRK-B, ^GSPC, etc. Accept upper alnum
// plus `-`, `_`, `/`, `.`, `^`. Length 1..16. Echoing back invalid input is
// also rejected so we never log/return attacker-controlled junk.
const QUOTE_SYMBOL_RX = /^[A-Z0-9.\-_/^]{1,16}$/;

export const router = express.Router();

router.get('/api/quote/:symbol', async (req, res) => {
  const sym = String(req.params.symbol || '').toUpperCase();
  if (!QUOTE_SYMBOL_RX.test(sym)) {
    return res.status(400).json({ error: 'invalid symbol' });
  }
  try {
    const quote = await getQuote(sym);
    if (!quote) return res.status(404).json({ error: 'quote not available', symbol: sym });
    res.json(quote);
  } catch (e) {
    _log?.warn({ err: safeErr(e), symbol: sym }, 'quote request failed');
    res.status(500).json({ error: 'internal error' });
  }
});

// Cap on the symbols list — protects upstreams from a single fan-out request.
// 10 covers the brief's TickerBar (BTC, ETH, SOL, SPX, NDX, EUR/USD, gold = 7)
// with headroom. Higher = more amplification per `/quotes/series` call.
const SERIES_MAX_SYMBOLS = 10;

router.get('/api/quotes/series', async (req, res) => {
  const rawSyms = String(req.query.symbols || '').trim();
  if (!rawSyms) return res.status(400).json({ error: 'missing symbols' });
  const symbols = rawSyms.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  if (symbols.length === 0 || symbols.length > SERIES_MAX_SYMBOLS) {
    return res.status(400).json({ error: `symbols must be 1..${SERIES_MAX_SYMBOLS} comma-separated tickers` });
  }
  if (!symbols.every(s => QUOTE_SYMBOL_RX.test(s))) {
    return res.status(400).json({ error: 'invalid symbol in list' });
  }
  // Reject duplicates so cache stats and upstream fan-out aren't gamed by
  // a client repeating the same symbol to bypass the cap.
  if (new Set(symbols).size !== symbols.length) {
    return res.status(400).json({ error: 'duplicate symbol in list' });
  }
  const window = String(req.query.window || '60m');
  if (!series.SUPPORTED_WINDOWS.includes(window)) {
    return res.status(400).json({ error: `invalid window (${series.SUPPORTED_WINDOWS.join('|')})` });
  }
  try {
    const result = await series.getSeries(symbols, window);
    res.json(result);
  } catch (e) {
    _log?.warn({ err: safeErr(e) }, 'quotes/series request failed');
    res.status(500).json({ error: 'internal error' });
  }
});
