import express from 'express';
import cron from 'node-cron';
import { timingSafeEqual } from 'node:crypto';
import { fetchFinnhubNews } from './finnhub.js';
import { fetchAlphaVantageNews } from './alphavantage.js';
import { ALL_TOPICS } from './topics.js';
import { safeErr } from '../utils/safeErr.js';

const TOPIC_SET = new Set(ALL_TOPICS);
const ASSET_RX = /^[A-Z0-9]{1,16}$/;
const TOPIC_RX = /^[A-Z_]{1,32}$/;

// State (module-scoped: one news module per process).
let _items = [];
let _lastRefreshAt = null;
let _lastFinnhubCount = 0;
let _lastAvCount = 0;
let _lastError = null;
let _running = false;
let _runCounter = 0;
let _cronJob = null;
let _log = null;
let _config = null;

function dedupeAndSort(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    if (!it?.url || seen.has(it.url)) continue;
    seen.add(it.url);
    out.push(it);
  }
  out.sort((a, b) => new Date(b.time_published) - new Date(a.time_published));
  return out;
}

async function refresh() {
  if (_running) {
    _log?.debug('news refresh skipped: already running');
    return;
  }
  _running = true;
  const startedAt = Date.now();
  try {
    _runCounter += 1;
    // Hit AV at run 1, then every avRunEvery runs: 1, 1+N, 1+2N, …
    // This guarantees a populated AV feed at boot rather than waiting one cron cycle.
    const callAv = _config.alphaVantageKey && ((_runCounter - 1) % _config.avRunEvery === 0);

    const tasks = [
      fetchFinnhubNews({
        apiKey: _config.finnhubKey,
        categories: _config.finnhubCategories,
        log: _log,
      }),
    ];
    tasks.push(callAv
      ? fetchAlphaVantageNews({ apiKey: _config.alphaVantageKey, log: _log })
      : Promise.resolve(null));

    const [fnItems, avResult] = await Promise.all(tasks);
    _lastFinnhubCount = fnItems.length;

    // Three states for the AV side:
    //   avResult == null            → AV was deliberately skipped this cycle (avRunEvery)
    //   avResult.rateLimited        → AV quota exhausted; preserve previous cache
    //   avResult.items.length >= 0  → AV succeeded (possibly empty)
    let merged;
    let avFlag = 'ok';
    if (avResult == null) {
      const previousAv = _items.filter(i => i.source_api === 'alphavantage');
      merged = dedupeAndSort([...fnItems, ...previousAv]);
      avFlag = 'skipped';
    } else if (avResult.rateLimited) {
      const previousAv = _items.filter(i => i.source_api === 'alphavantage');
      merged = dedupeAndSort([...fnItems, ...previousAv]);
      _lastError = 'av_rate_limited';
      avFlag = 'rate_limited';
    } else {
      _lastAvCount = avResult.items.length;
      merged = dedupeAndSort([...fnItems, ...avResult.items]);
    }

    _items = merged;
    _lastRefreshAt = new Date().toISOString();
    if (avFlag !== 'rate_limited') _lastError = null;
    _log?.info(
      { items: merged.length, finnhub: _lastFinnhubCount, alphavantage: avFlag === 'ok' ? _lastAvCount : avFlag, ms: Date.now() - startedAt },
      'news refresh done',
    );
  } catch (err) {
    _lastError = safeErr(err);
    _log?.error({ err: _lastError }, 'news refresh failed');
  } finally {
    _running = false;
  }
}

export async function start({ log, config }) {
  _log = log.child({ module: 'news' });
  _config = config;

  await refresh(); // warm cache before serving traffic

  if (cron.validate(config.refreshCron)) {
    _cronJob = cron.schedule(config.refreshCron, () => { refresh(); });
    _log.info({ cron: config.refreshCron, avRunEvery: config.avRunEvery }, 'news cron scheduled');
  } else {
    _log.error({ cron: config.refreshCron }, 'invalid cron expression — news will not auto-refresh');
  }
}

export function stop() {
  if (_cronJob) { _cronJob.stop(); _cronJob = null; }
}

// 2h = 4 missed cycles at the default 30-minute cron. Generous enough to ride
// through a transient Finnhub/AV outage without flagging the module as down.
const NEWS_STALE_MS = 2 * 60 * 60 * 1000;

export function status() {
  const lastTs = _lastRefreshAt ? Date.parse(_lastRefreshAt) : null;
  const stale = lastTs == null ? true : (Date.now() - lastTs) > NEWS_STALE_MS;
  return {
    enabled: !!_lastRefreshAt,
    stale,
    lastRefreshAt: _lastRefreshAt,
    items: _items.length,
    lastFinnhubCount: _lastFinnhubCount,
    lastAvCount: _lastAvCount,
    runCounter: _runCounter,
    cron: _config?.refreshCron,
    avRunEvery: _config?.avRunEvery,
    lastError: _lastError,
  };
}

// Returns either a filtered slice or a `{ error, status }` shape that the
// route hands to `res`. Keeps validation out of the route handler.
function filterItems({ topic, asset, limit }) {
  let out = _items;
  if (topic !== undefined && topic !== '') {
    if (typeof topic !== 'string' || !TOPIC_RX.test(topic.toUpperCase())) {
      return { error: 'invalid topic', status: 400 };
    }
    const t = topic.toUpperCase();
    if (!TOPIC_SET.has(t)) return { error: 'unknown topic', status: 400 };
    out = out.filter(it => it.topics.some(x => x.topic === t));
  }
  if (asset !== undefined && asset !== '') {
    if (typeof asset !== 'string' || !ASSET_RX.test(asset.toUpperCase())) {
      return { error: 'invalid asset', status: 400 };
    }
    const a = asset.toUpperCase();
    out = out.filter(it => it.assets.includes(a));
  }
  // Strict bounds — rejects invalid inputs instead of silently clamping.
  // Aligns with /api/liquidations behavior so a bad client gets a clear 400
  // rather than mysteriously different page sizes.
  let cap = 200;
  if (limit !== undefined && limit !== '') {
    const n = Number(limit);
    if (!Number.isFinite(n) || n < 1 || n > 500) {
      return { error: 'invalid limit (1..500)', status: 400 };
    }
    cap = n;
  }
  return out.slice(0, cap);
}

function bearerMatches(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

function reply(res, result) {
  if (result && !Array.isArray(result) && result.error) {
    return res.status(result.status || 400).json({ error: result.error });
  }
  res.json(result);
}

export const router = express.Router();

router.get('/api/news', (req, res) => {
  reply(res, filterItems({
    topic: req.query.topic,
    asset: req.query.asset,
    limit: req.query.limit,
  }));
});

router.get('/api/news/:topic', (req, res) => {
  reply(res, filterItems({
    topic: req.params.topic,
    asset: req.query.asset,
    limit: req.query.limit,
  }));
});

router.post('/api/news/refresh', (req, res) => {
  // Endpoint disabled when no token is configured — prevents anyone from
  // burning Finnhub/AV quotas on a forgotten production deploy.
  const expected = _config?.refreshToken;
  if (!expected) {
    return res.status(503).json({ error: 'refresh disabled (no token configured)' });
  }
  const auth = req.get('authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(auth);
  if (!match || !bearerMatches(match[1], expected)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (_running) {
    res.set('Retry-After', '5');
    return res.status(429).json({ error: 'refresh already running' });
  }
  // Fire-and-forget to keep the response fast; idempotence enforced via _running.
  refresh();
  res.json({ ok: true, triggered: true });
});