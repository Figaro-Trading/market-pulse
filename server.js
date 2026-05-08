import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import pinoHttp from 'pino-http';
import pino from 'pino';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as news from './src/news/index.js';
import * as liquidations from './src/liquidations/index.js';
import * as quotes from './src/quotes/index.js';
import * as derivatives from './src/derivatives/index.js';
import { renderMetrics } from './src/metrics.js';
import { safeErr } from './src/utils/safeErr.js';
import { numEnv } from './src/utils/env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const log = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: process.stdout.isTTY ? { target: 'pino-pretty' } : undefined,
});

const app = express();
app.disable('x-powered-by');
// Trust proxy is OFF by default: accepting X-Forwarded-* without a proxy in
// front lets a client spoof its IP and bypass the rate-limiter. Set
// TRUST_PROXY=1 (or a CIDR/'loopback') only when actually fronted by a
// trusted reverse proxy.
const TRUST_PROXY = (() => {
  const raw = process.env.TRUST_PROXY;
  if (raw == null || raw === '' || raw === 'false') return false;
  if (raw === 'true') return true;
  if (/^\d+$/.test(raw)) return Number(raw);
  return raw;
})();
app.set('trust proxy', TRUST_PROXY);

// HTTP request log. Errors logged at warn (4xx) / error (5xx) automatically.
app.use(pinoHttp({
  logger: log,
  // Strip the URL's query string from logs — it can carry symbol or limit
  // params, but never tokens (we never proxy `?apikey=…`), so this is mostly
  // for log volume control.
  serializers: {
    req: (req) => ({ method: req.method, url: req.url?.split('?')[0], remoteAddress: req.remoteAddress }),
  },
}));

// Default helmet headers: CSP, HSTS, X-Content-Type-Options, frame-ancestors,
// referrer-policy, etc. Default CSP allows 'unsafe-inline' for style-src,
// which keeps the inline <style> in public/index.html working.
app.use(helmet());

// Global rate limit. Frontend polls ~10 req/min per tab; 120/min/IP gives
// generous headroom while rejecting trivial abuse.
const globalLimiter = rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  // Don't count the orchestrator's healthcheck against the limit.
  skip: (req) => req.path === '/api/health' || req.path === '/livez' || req.path === '/readyz' || req.path === '/metrics',
});
app.use(globalLimiter);

// Stricter limiter for `/api/quote/*`: each cache miss fans out to Yahoo /
// Nasdaq / Coinbase, so an attacker iterating distinct symbols amplifies into
// upstream pressure (and risks IP-block of the pod). Default 30/min/IP.
const quoteLimiter = rateLimit({
  // Clamp to ≥1: express-rate-limit throws on 0/negative, and silently
  // disabling the limiter via a typo would defeat the protection it exists
  // for (per-IP cap on the upstream-amplifying endpoint).
  windowMs: 60_000,
  limit: Math.max(1, numEnv('QUOTE_RATE_LIMIT', 30)),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

const PORT = Math.max(1, numEnv('PORT', 3001));
const startedAt = new Date().toISOString();

const newsConfig = {
  finnhubKey:        process.env.FINNHUB_KEY || '',
  alphaVantageKey:   process.env.ALPHAVANTAGE_KEY || '',
  refreshCron:       process.env.NEWS_REFRESH_CRON || '*/30 * * * *',
  finnhubCategories: (process.env.FINNHUB_CATEGORIES || 'general,forex,crypto,merger')
                       .split(',').map(s => s.trim()).filter(Boolean),
  avRunEvery:        Math.max(1, numEnv('AV_RUN_EVERY', 2)),
  // Bearer token for the manual `POST /api/news/refresh` endpoint. If empty,
  // the endpoint returns 503 (disabled). Set in production to a long random
  // string and never share it client-side.
  refreshToken:      process.env.NEWS_REFRESH_TOKEN || '',
};

const liqConfig = {
  exchanges:    (process.env.LIQ_EXCHANGES || 'binance,bybit,bitmex')
                  .split(',').map(s => s.trim()).filter(Boolean),
  bufferSize:   numEnv('LIQ_BUFFER_SIZE', 50_000),
  bybitSymbols: process.env.LIQ_BYBIT_SYMBOLS
                  ? process.env.LIQ_BYBIT_SYMBOLS.split(',').map(s => s.trim()).filter(Boolean)
                  : null,
  binanceCoinM: process.env.LIQ_BINANCE_COIN_M !== 'false',
  // 0 is meaningful here (disable the default threshold). numEnv preserves it
  // where `Number(env) || 1_000_000` would clobber it.
  minNotional:  Math.max(0, numEnv('LIQ_MIN_NOTIONAL_USD', 1_000_000)),
};

const quotesConfig = {
  cacheTtlMs: numEnv('QUOTE_CACHE_TTL_MS', 10_000),
};

const derivConfig = {
  refreshMs: numEnv('DERIV_REFRESH_MS', 5 * 60 * 1000),
  symbols:   (process.env.DERIV_SYMBOLS || 'BTCUSDT,ETHUSDT,SOLUSDT')
               .split(',').map(s => s.trim()).filter(Boolean),
};

// Module registry — each phase replaces a stub with the real init / status getter.
const modules = {
  news:         { status: news.status },
  liquidations: { status: liquidations.status },
  quotes:       { status: quotes.status },
  derivatives:  { status: derivatives.status },
};

// Modules whose degradation makes the service "not ready" — quotes are
// on-demand and don't block readiness.
const CRITICAL_MODULES = ['news', 'liquidations', 'derivatives'];

function moduleStates() {
  return Object.fromEntries(
    Object.entries(modules).map(([k, m]) => [k, m.status()])
  );
}

function readinessReport() {
  const states = moduleStates();
  const failed = CRITICAL_MODULES.filter(k => !states[k]?.enabled || states[k]?.stale);
  return { ready: failed.length === 0, failed, modules: states };
}

const startedAtMs = Date.now();

// /livez = process is alive (no module checks). Used by Kubernetes liveness;
// always 200 unless the process itself is gone.
app.get('/livez', (_req, res) => {
  res.json({ ok: true, uptimeSeconds: Math.round(process.uptime()) });
});

// Prometheus exposition endpoint. Pulls from each module's status() — same
// source of truth as /api/health, so they can never diverge.
app.get('/metrics', (_req, res) => {
  res.type('text/plain; version=0.0.4; charset=utf-8').send(renderMetrics(modules, { startedAtMs }));
});

// /readyz = process is ready to serve. 503 if any critical module is down
// or stale. Used by Kubernetes readiness and the Docker HEALTHCHECK.
app.get('/readyz', (_req, res) => {
  const r = readinessReport();
  res.status(r.ready ? 200 : 503).json(r);
});

// /api/health keeps the rich shape for human inspection and the frontend
// dashboard. Returns 503 when not ready so a generic uptime monitor sees red.
app.get('/api/health', (_req, res) => {
  const r = readinessReport();
  res.status(r.ready ? 200 : 503).json({
    name: 'market-pulse',
    startedAt,
    uptimeSeconds: Math.round(process.uptime()),
    ready: r.ready,
    failed: r.failed,
    modules: r.modules,
  });
});

// Versioning hook: requests to `/api/v1/<path>` are transparently rewritten
// to `/api/<path>` and handled by the same routers. This gives clients a
// stable v1 surface to depend on while keeping the legacy `/api/...` shape
// working — when v2 lands, only this rewriter and the new v2 routers change.
// Mounted at the app root (not at /api/v1) so the rewrite affects the full
// `req.url` and downstream routers see the canonical /api/* path.
app.use((req, _res, next) => {
  if (req.url.startsWith('/api/v1/')) {
    req.url = '/api/' + req.url.slice('/api/v1/'.length);
  } else if (req.url === '/api/v1' || req.url.startsWith('/api/v1?')) {
    req.url = '/api' + req.url.slice('/api/v1'.length);
  }
  next();
});

app.use(news.router);
app.use(liquidations.router);
// Both `/api/quote/*` and `/api/quotes/series` fan out to upstream providers
// (Yahoo / Coinbase / Nasdaq), so they share the same per-IP budget. The
// limiter is the same instance — counters are keyed by req.ip.
app.use('/api/quote',  quoteLimiter);
app.use('/api/quotes', quoteLimiter);
app.use(quotes.router);
app.use(derivatives.router);
app.use(express.static(path.join(__dirname, 'public')));

// JSON 404 for unknown /api/* paths (the static middleware already handles
// the SPA's index.html for non-/api requests).
app.use('/api', (_req, res) => res.status(404).json({ error: 'not found' }));

// Express error handler — 4-arg signature is what marks it as such. Catches
// sync throws and `next(err)` calls from any route. Without it, Express
// returns the stack trace as plain text in non-production mode.
app.use((err, req, res, _next) => {
  req.log?.error({ err: safeErr(err), path: req.path }, 'unhandled request error');
  if (res.headersSent) return;
  res.status(500).json({ error: 'internal error' });
});

// Start every module before binding the HTTP listener so that the first
// request never hits empty caches or pre-init state. Modules run in parallel:
// news + derivatives both await an upstream fetch, sequential await would
// double the cold-start TTI.
async function startModules() {
  const safe = (label, fn) => Promise.resolve()
    .then(fn)
    .catch((e) => log.error({ err: safeErr(e) }, `failed to start ${label} module`));
  await Promise.all([
    safe('news',         () => news.start({ log, config: newsConfig })),
    safe('liquidations', () => liquidations.start({ log, config: liqConfig })),
    safe('quotes',       () => quotes.start({ log, config: quotesConfig })),
    safe('derivatives',  () => derivatives.start({ log, config: derivConfig })),
  ]);
}

// Only run the bootstrap when this file is the program entrypoint. Importing
// it from a test (`import { app } from '../server.js'`) gives the test a
// pre-configured Express instance without firing real HTTP listeners,
// WebSocket connections or signal handlers.
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  await startModules();

  const server = app.listen(PORT, () => {
    log.info({ port: PORT }, 'market-pulse listening');
  });

  let shuttingDown = false;
  const shutdown = async (signal, code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'shutting down');

    // Hard kill if graceful path stalls (e.g. WS .close hung).
    const force = setTimeout(() => {
      log.error('shutdown timed out — forcing exit');
      process.exit(1);
    }, 5000);
    force.unref();

    try { news.stop(); }         catch (e) { log.warn({ err: safeErr(e) }, 'news stop failed'); }
    try { liquidations.stop(); } catch (e) { log.warn({ err: safeErr(e) }, 'liquidations stop failed'); }
    try { derivatives.stop(); }  catch (e) { log.warn({ err: safeErr(e) }, 'derivatives stop failed'); }

    await new Promise((resolve) => server.close(resolve));
    // Flush pending pino transport writes (pino-pretty worker can drop the
    // tail of the log otherwise).
    await log.flush?.();
    clearTimeout(force);
    process.exit(code);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    log.error({ err: safeErr(reason) }, 'unhandled promise rejection');
  });
  process.on('uncaughtException', (err) => {
    log.error({ err: safeErr(err) }, 'uncaught exception');
    shutdown('uncaughtException', 1);
  });
}

export { app, log, modules, startModules };
