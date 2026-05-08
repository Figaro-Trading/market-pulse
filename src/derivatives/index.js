import express from 'express';
import { fetchBybitLinearTickers } from './bybitTickers.js';
import { safeErr } from '../utils/safeErr.js';

// Module state.
let _log = null;
let _refreshMs = 5 * 60 * 1000;
let _trackedSymbols = [];        // informational — exposed in /api/health
let _snapshot = null;            // { [SYMBOL]: derivative-row }
let _lastFetchedAt = null;
let _lastError = null;
let _refreshing = false;
let _timer = null;

async function refresh() {
  if (_refreshing) return;
  _refreshing = true;
  const startedAt = Date.now();
  try {
    const data = await fetchBybitLinearTickers({ log: _log });
    if (data) {
      _snapshot = data;
      _lastFetchedAt = new Date().toISOString();
      _lastError = null;
      _log?.info({ symbols: Object.keys(data).length, ms: Date.now() - startedAt }, 'derivatives snapshot refreshed');
    } else {
      _lastError = 'fetch returned null';
    }
  } catch (e) {
    _lastError = safeErr(e);
    _log?.warn({ err: _lastError }, 'derivatives refresh failed');
  } finally {
    _refreshing = false;
  }
}

// ── Public API ────────────────────────────────────────────────────────────

export async function start({ log, config }) {
  _log = log.child({ module: 'derivatives' });
  _refreshMs = Math.max(30_000, Number(config?.refreshMs) || 5 * 60 * 1000);
  _trackedSymbols = (config?.symbols || []).map(s => String(s).toUpperCase());

  await refresh(); // warm cache before serving traffic
  _timer = setInterval(refresh, _refreshMs);
  _timer.unref?.();

  _log.info({ refreshMs: _refreshMs, tracked: _trackedSymbols }, 'derivatives module started');
}

export function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

export function status() {
  const symCount = _snapshot ? Object.keys(_snapshot).length : 0;
  // Sample of tracked symbols' current rows for at-a-glance health.
  const tracked = {};
  if (_snapshot) {
    for (const s of _trackedSymbols) {
      const row = _snapshot[s];
      if (row) {
        tracked[s] = {
          lastPrice: row.lastPrice,
          fundingRatePct: row.fundingRatePct,
          openInterestValueUsd: row.openInterestValueUsd,
        };
      }
    }
  }
  // Stale if the Bybit fetch hasn't succeeded in twice the configured cadence
  // (e.g. 10 min on the default 5-min refresh).
  const lastTs = _lastFetchedAt ? Date.parse(_lastFetchedAt) : null;
  const stale = lastTs == null ? true : (Date.now() - lastTs) > 2 * _refreshMs;
  return {
    enabled: _log != null,
    stale,
    refreshMs: _refreshMs,
    lastFetchedAt: _lastFetchedAt,
    lastError: _lastError,
    symbolsCached: symCount,
    tracked,
  };
}

function lookup(symbol) {
  if (!_snapshot) return null;
  const key = String(symbol || '').trim().toUpperCase();
  if (!key) return null;
  return _snapshot[key] || null;
}

// ── HTTP API ──────────────────────────────────────────────────────────────

// Bybit linear perp symbols: upper alnum, sometimes prefixed `1000`. 1..32.
const PERP_SYMBOL_RX = /^[A-Z0-9]{1,32}$/;

function paramSymbol(req, res) {
  const sym = String(req.params.symbol || '').toUpperCase();
  if (!PERP_SYMBOL_RX.test(sym)) {
    res.status(400).json({ error: 'invalid symbol' });
    return null;
  }
  return sym;
}

export const router = express.Router();

router.get('/api/funding/:symbol', (req, res) => {
  const sym = paramSymbol(req, res); if (!sym) return;
  const row = lookup(sym);
  if (!row) return res.status(404).json({ error: 'symbol not in cache', symbol: sym });
  res.json({
    symbol: row.symbol,
    fundingRate: row.fundingRate,
    fundingRatePct: row.fundingRatePct,
    nextFundingTime: row.nextFundingTime,
    source: row.source,
    fetchedAt: row.fetchedAt,
  });
});

router.get('/api/open-interest/:symbol', (req, res) => {
  const sym = paramSymbol(req, res); if (!sym) return;
  const row = lookup(sym);
  if (!row) return res.status(404).json({ error: 'symbol not in cache', symbol: sym });
  res.json({
    symbol: row.symbol,
    openInterest: row.openInterest,
    openInterestValueUsd: row.openInterestValueUsd,
    lastPrice: row.lastPrice,
    source: row.source,
    fetchedAt: row.fetchedAt,
  });
});

// Bonus: full row + listing.
router.get('/api/derivatives/:symbol', (req, res) => {
  const sym = paramSymbol(req, res); if (!sym) return;
  const row = lookup(sym);
  if (!row) return res.status(404).json({ error: 'symbol not in cache', symbol: sym });
  res.json(row);
});

router.get('/api/derivatives', (_req, res) => {
  if (!_snapshot) return res.status(503).json({ error: 'snapshot not yet ready' });
  // Return a compact list (symbol + key fields) sorted by 24h turnover desc.
  const list = Object.values(_snapshot)
    .map(r => ({
      symbol: r.symbol,
      lastPrice: r.lastPrice,
      fundingRatePct: r.fundingRatePct,
      openInterestValueUsd: r.openInterestValueUsd,
      turnover24hUsd: r.turnover24hUsd,
      price24hPct: r.price24hPct,
    }))
    .sort((a, b) => (b.turnover24hUsd || 0) - (a.turnover24hUsd || 0));
  res.json({ count: list.length, fetchedAt: _lastFetchedAt, list });
});
