import express from 'express';
import { createBinanceClient } from './binance.js';
import { createBybitClient } from './bybit.js';
import { createBitmexClient } from './bitmex.js';

// Module-level state. One liquidations module per process.
let _log = null;
let _config = null;
let _bufferSize = 50_000;
let _buffer = [];
let _writeIdx = 0;
let _totalReceived = 0;
let _seen = new Set();           // recent ids for cross-source dedup
const SEEN_LIMIT = 4_000;
let _defaultMinNotional = 0;     // applied when /api/liquidations omits ?min_notional

const clients = {};

function rememberSeen(id) {
  if (_seen.has(id)) return false;
  _seen.add(id);
  if (_seen.size > SEEN_LIMIT) {
    _seen = new Set(Array.from(_seen).slice(-Math.floor(SEEN_LIMIT / 2)));
  }
  return true;
}

function pushItem(item) {
  if (!item || !rememberSeen(item.id)) return;
  _totalReceived += 1;
  if (_buffer.length < _bufferSize) {
    _buffer.push(item);
  } else {
    _buffer[_writeIdx] = item;
    _writeIdx = (_writeIdx + 1) % _bufferSize;
  }
}

// Yields buffer items newest-first, without allocating a copy. `_writeIdx`
// points to the slot of the NEXT write — which is also where the oldest item
// currently lives once the buffer is full. So the most recent item is at
// `(_writeIdx - 1 + size) % size`. While the buffer is still filling
// (length < bufferSize), `_writeIdx` is 0 and the newest is at `length - 1`.
function* iterateNewest() {
  if (_buffer.length === 0) return;
  if (_buffer.length < _bufferSize) {
    for (let i = _buffer.length - 1; i >= 0; i--) yield _buffer[i];
    return;
  }
  const size = _bufferSize;
  let idx = (_writeIdx - 1 + size) % size;
  for (let n = 0; n < size; n++) {
    yield _buffer[idx];
    idx = (idx - 1 + size) % size;
  }
}

// ── Public API ────────────────────────────────────────────────────────────

// Hard ceiling on the ring buffer size — protects against an OOM if
// LIQ_BUFFER_SIZE is misconfigured. 200k entries × ~250 bytes = ~50 MB heap.
const BUFFER_SIZE_MAX = 200_000;

export function start({ log, config }) {
  _log = log.child({ module: 'liquidations' });
  _config = config;
  const requested = Number(config.bufferSize) || 50_000;
  _bufferSize = Math.min(BUFFER_SIZE_MAX, Math.max(100, requested));
  if (_bufferSize !== requested) {
    _log.warn({ requested, applied: _bufferSize }, 'liquidations buffer size clamped');
  }
  _defaultMinNotional = Math.max(0, Number(config.minNotional) || 0);
  _buffer = [];
  _writeIdx = 0;

  const enabled = new Set(
    (config.exchanges || ['binance', 'bybit', 'bitmex'])
      .map(s => String(s).trim().toLowerCase())
      .filter(Boolean)
  );

  if (enabled.has('binance')) {
    clients.binance = createBinanceClient({
      log: _log.child({ exchange: 'binance' }),
      onItem: pushItem,
      enableCoinM: config.binanceCoinM !== false,
    });
    clients.binance.start();
  }
  if (enabled.has('bybit')) {
    clients.bybit = createBybitClient({
      log: _log.child({ exchange: 'bybit' }),
      onItem: pushItem,
      symbols: config.bybitSymbols,
    });
    clients.bybit.start();
  }
  if (enabled.has('bitmex')) {
    clients.bitmex = createBitmexClient({
      log: _log.child({ exchange: 'bitmex' }),
      onItem: pushItem,
    });
    clients.bitmex.start();
  }

  _log.info({ exchanges: [...enabled], bufferSize: _bufferSize }, 'liquidations module started');
}

export function stop() {
  for (const c of Object.values(clients)) c?.stop?.();
}

// 30 min without any event across all clients is the cliff: even quiet
// markets see liquidations more often than that across 3 exchanges.
const LIQ_STALE_MS = 30 * 60 * 1000;
const _bootedAt = Date.now();

function aggregateClientStats(rawClients) {
  let connected = 0;
  let total = 0;
  let lastTs = 0;
  for (const c of Object.values(rawClients)) {
    const s = c?.status?.();
    if (!s) continue;
    // Two shapes: { connected, lastEventAt } or { fstream:{...}, dstream:{...} }.
    const subs = s.connected !== undefined ? [s] : Object.values(s).filter(v => v && typeof v === 'object');
    for (const sub of subs) {
      if (sub.connected !== undefined) {
        total += 1;
        if (sub.connected) connected += 1;
      }
      if (sub.lastEventAt) {
        const t = Date.parse(sub.lastEventAt);
        if (Number.isFinite(t) && t > lastTs) lastTs = t;
      }
    }
  }
  return { connected, total, lastTs };
}

export function status() {
  const rawClients = Object.fromEntries(
    Object.entries(clients).map(([k, c]) => [k, c.status()])
  );
  const { connected, total, lastTs } = aggregateClientStats(clients);
  // No event yet: only flag stale once we've been up long enough that one
  // would reasonably have arrived.
  const stale = lastTs === 0
    ? (Date.now() - _bootedAt) > LIQ_STALE_MS
    : (Date.now() - lastTs) > LIQ_STALE_MS;

  return {
    enabled: Object.keys(clients).length > 0,
    stale,
    connectedClients: connected,
    totalClients: total,
    lastEventAt: lastTs ? new Date(lastTs).toISOString() : null,
    bufferSize: _bufferSize,
    items: _buffer.length,
    totalReceived: _totalReceived,
    clients: rawClients,
  };
}

// Used by Phase 4 API.
export function getItems({ minNotional, since, limit, exchange, symbol } = {}) {
  const minNot = Number(minNotional) || 0;
  const sinceTs = since ? Date.parse(since) : null;
  const exFilter = exchange
    ? new Set(String(exchange).split(',').map(s => s.trim().toLowerCase()).filter(Boolean))
    : null;
  const symFilter = symbol ? String(symbol).toUpperCase() : null;
  const cap = Math.max(1, Math.min(1000, Number(limit) || 200));

  const out = [];
  for (const it of iterateNewest()) {
    if (it.notional < minNot) continue;
    if (sinceTs != null && Date.parse(it.ts) <= sinceTs) continue;
    if (exFilter && !exFilter.has(it.exchange)) continue;
    if (symFilter && it.symbol !== symFilter) continue;
    out.push(it);
    if (out.length >= cap) break;
  }
  return out;
}

export function getStats() {
  const now = Date.now();
  const ONE_HOUR = 3_600_000;
  const ONE_DAY = 24 * ONE_HOUR;

  let count1h = 0, count24h = 0;
  let notional1h = 0, notional24h = 0;
  let longNotional24h = 0, shortNotional24h = 0;
  let totalItems = 0;
  const symbolNotional = new Map();
  const exchangeNotional = new Map();

  for (const it of iterateNewest()) {
    totalItems++;
    const t = Date.parse(it.ts);
    const age = now - t;
    if (age <= ONE_HOUR) { count1h++; notional1h += it.notional; }
    if (age <= ONE_DAY) {
      count24h++;
      notional24h += it.notional;
      if (it.side === 'long')  longNotional24h  += it.notional;
      else                     shortNotional24h += it.notional;
      symbolNotional.set(it.symbol,    (symbolNotional.get(it.symbol)   || 0) + it.notional);
      exchangeNotional.set(it.exchange,(exchangeNotional.get(it.exchange) || 0) + it.notional);
    }
  }

  const topSymbols = [...symbolNotional.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([symbol, notional]) => ({ symbol, notional: Math.round(notional) }));

  const byExchange = Object.fromEntries(
    [...exchangeNotional.entries()].map(([k, v]) => [k, Math.round(v)])
  );

  return {
    count1h,
    count24h,
    notional1h: Math.round(notional1h),
    notional24h: Math.round(notional24h),
    longNotional24h: Math.round(longNotional24h),
    shortNotional24h: Math.round(shortNotional24h),
    topSymbols,
    byExchange,
    items: totalItems,
    totalReceived: _totalReceived,
  };
}

// ── HTTP API ──────────────────────────────────────────────────────────────

const SYMBOL_RX     = /^[A-Z0-9]{1,32}$/;            // raw exchange symbols are usually upper alnum
const EXCHANGE_SET  = new Set(['binance', 'bybit', 'bitmex']);

function validateQuery(q) {
  // min_notional: finite number, 0 <= n <= 1e12.
  let minNotional = _defaultMinNotional;
  if (q.min_notional !== undefined) {
    const n = Number(q.min_notional);
    if (!Number.isFinite(n) || n < 0 || n > 1e12) return { error: 'invalid min_notional' };
    minNotional = n;
  }
  // since: ISO 8601 → epoch ms, must parse.
  let since = null;
  if (q.since !== undefined && q.since !== '') {
    const t = Date.parse(q.since);
    if (!Number.isFinite(t)) return { error: 'invalid since (ISO 8601 expected)' };
    since = q.since;
  }
  // limit: 1..1000.
  let limit = 200;
  if (q.limit !== undefined) {
    const n = Number(q.limit);
    if (!Number.isFinite(n) || n < 1 || n > 1000) return { error: 'invalid limit (1..1000)' };
    limit = n;
  }
  // exchange: comma-separated allowlist.
  let exchange;
  if (q.exchange !== undefined && q.exchange !== '') {
    if (typeof q.exchange !== 'string' || q.exchange.length > 64) return { error: 'invalid exchange' };
    const parts = q.exchange.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    if (parts.some(p => !EXCHANGE_SET.has(p))) return { error: 'unknown exchange' };
    exchange = parts.join(',');
  }
  // symbol: short alnum.
  let symbol;
  if (q.symbol !== undefined && q.symbol !== '') {
    if (typeof q.symbol !== 'string' || !SYMBOL_RX.test(q.symbol.toUpperCase())) {
      return { error: 'invalid symbol' };
    }
    symbol = q.symbol.toUpperCase();
  }
  return { minNotional, since, limit, exchange, symbol };
}

export const router = express.Router();

router.get('/api/liquidations', (req, res) => {
  const v = validateQuery(req.query);
  if (v.error) return res.status(400).json({ error: v.error });
  res.json(getItems(v));
});

router.get('/api/liquidations/stats', (_req, res) => {
  res.json(getStats());
});
