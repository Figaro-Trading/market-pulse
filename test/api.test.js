// Integration tests for the HTTP surface.
// We import `app` directly (server.js skips startModules()/listen() when not
// the program entrypoint), so these tests don't open WebSockets, don't fetch
// upstream APIs, and run in milliseconds.
//
// All assertions cover the **schema/validation/headers** layer — the layer
// that has caused most production incidents in similar codebases. Module
// behavior (refresh logic, normalization, dedup) is covered separately by
// smoke.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { app } from '../server.js';

// ── Health surface ─────────────────────────────────────────────────────────

test('GET /livez always returns 200', async () => {
  const res = await request(app).get('/livez');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.ok(Number.isFinite(res.body.uptimeSeconds));
});

test('GET /readyz returns 503 when modules are not initialized', async () => {
  // In tests we don't call startModules(), so all critical modules report
  // enabled:false → readyz must signal not-ready.
  const res = await request(app).get('/readyz');
  assert.equal(res.status, 503);
  assert.equal(res.body.ready, false);
  // News, liquidations and derivatives are the critical set.
  assert.deepEqual(
    res.body.failed.sort(),
    ['derivatives', 'liquidations', 'news'],
  );
});

test('GET /api/health returns 503 with full module shape when not ready', async () => {
  const res = await request(app).get('/api/health');
  assert.equal(res.status, 503);
  assert.equal(res.body.ready, false);
  assert.equal(res.body.name, 'market-pulse');
  for (const k of ['news', 'liquidations', 'quotes', 'derivatives']) {
    assert.ok(res.body.modules[k], `missing module ${k}`);
    assert.ok('enabled' in res.body.modules[k]);
    assert.ok('stale'   in res.body.modules[k]);
  }
});

// ── Security headers ───────────────────────────────────────────────────────

test('Security headers from helmet are present', async () => {
  const res = await request(app).get('/livez');
  assert.match(res.headers['strict-transport-security'], /max-age=\d+/);
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['x-frame-options'], 'SAMEORIGIN');
  assert.match(res.headers['content-security-policy'], /default-src 'self'/);
  assert.equal(res.headers['referrer-policy'], 'no-referrer');
});

test('X-Powered-By is removed', async () => {
  const res = await request(app).get('/livez');
  assert.equal(res.headers['x-powered-by'], undefined);
});

// ── 404 and error shapes ───────────────────────────────────────────────────

test('GET /api/unknown returns JSON 404 (not the static fallback)', async () => {
  const res = await request(app).get('/api/this-endpoint-does-not-exist');
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'not found');
});

// ── Validation: news ───────────────────────────────────────────────────────

test('GET /api/news with no query is 200 and returns an array', async () => {
  const res = await request(app).get('/api/news');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
});

test('GET /api/news?topic=NOTREAL returns 400', async () => {
  const res = await request(app).get('/api/news').query({ topic: 'NOTREAL' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /topic/);
});

test('GET /api/news?topic=CRYPTO is accepted', async () => {
  const res = await request(app).get('/api/news').query({ topic: 'CRYPTO' });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
});

test('GET /api/news?asset=*** returns 400', async () => {
  const res = await request(app).get('/api/news').query({ asset: '!!!' });
  assert.equal(res.status, 400);
});

test('GET /api/news?limit=99999 returns 400 (strict bounds)', async () => {
  const res = await request(app).get('/api/news').query({ limit: 99999 });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /limit/);
});

test('GET /api/news?limit=abc returns 400 (no silent fallback)', async () => {
  const res = await request(app).get('/api/news').query({ limit: 'abc' });
  assert.equal(res.status, 400);
});

test('GET /api/news?limit=500 is accepted (boundary)', async () => {
  const res = await request(app).get('/api/news').query({ limit: 500 });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
});

// ── Auth: refresh endpoint ─────────────────────────────────────────────────

test('POST /api/news/refresh returns 503 when no token is configured', async () => {
  // The test process doesn't set NEWS_REFRESH_TOKEN by default.
  const res = await request(app).post('/api/news/refresh');
  assert.equal(res.status, 503);
});

// ── Versioning rewriter: /api/v1/* → /api/* ────────────────────────────────

test('GET /api/v1/news is rewritten to /api/news (200)', async () => {
  const res = await request(app).get('/api/v1/news');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
});

test('GET /api/v1/news?topic=NOTREAL is rewritten and validates (400)', async () => {
  const res = await request(app).get('/api/v1/news').query({ topic: 'NOTREAL' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /topic/);
});

test('GET /api/v1/unknown returns JSON 404 (rewritten and falls through)', async () => {
  const res = await request(app).get('/api/v1/this-does-not-exist');
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'not found');
});

// ── Validation: liquidations ───────────────────────────────────────────────

test('GET /api/liquidations?min_notional=abc returns 400', async () => {
  const res = await request(app).get('/api/liquidations').query({ min_notional: 'abc' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /min_notional/);
});

test('GET /api/liquidations?since=garbage returns 400', async () => {
  const res = await request(app).get('/api/liquidations').query({ since: 'garbage' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /since/);
});

test('GET /api/liquidations?limit=99999 returns 400 (cap=1000)', async () => {
  const res = await request(app).get('/api/liquidations').query({ limit: 99999 });
  assert.equal(res.status, 400);
});

test('GET /api/liquidations?exchange=ftx returns 400 (unknown exchange)', async () => {
  const res = await request(app).get('/api/liquidations').query({ exchange: 'ftx' });
  assert.equal(res.status, 400);
});

// ── Validation: quotes ─────────────────────────────────────────────────────

test('GET /api/quote/!@# returns 400', async () => {
  const res = await request(app).get('/api/quote/' + encodeURIComponent('!@#'));
  assert.equal(res.status, 400);
});

// ── Validation: quotes/series ──────────────────────────────────────────────

test('GET /api/quotes/series with no symbols returns 400', async () => {
  const res = await request(app).get('/api/quotes/series');
  assert.equal(res.status, 400);
  assert.match(res.body.error, /symbols/);
});

test('GET /api/quotes/series with > 10 symbols returns 400', async () => {
  const eleven = 'A,B,C,D,E,F,G,H,I,J,K';
  const res = await request(app).get('/api/quotes/series').query({ symbols: eleven });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /1\.\.10/);
});

test('GET /api/quotes/series with invalid window returns 400', async () => {
  const res = await request(app).get('/api/quotes/series')
    .query({ symbols: 'BTC', window: '99y' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /window/);
});

test('GET /api/quotes/series with invalid symbol char returns 400', async () => {
  const res = await request(app).get('/api/quotes/series')
    .query({ symbols: 'BTC,!!!' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /invalid symbol/);
});

test('GET /api/quotes/series with duplicate symbols returns 400', async () => {
  const res = await request(app).get('/api/quotes/series')
    .query({ symbols: 'BTC,ETH,BTC' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /duplicate/);
});

test('GET /api/v1/quotes/series is reachable via the rewriter', async () => {
  // Validates rewriter wiring: 400 for bad window beats network entirely.
  const res = await request(app).get('/api/v1/quotes/series')
    .query({ symbols: 'BTC', window: 'bogus' });
  assert.equal(res.status, 400);
});

// ── Validation: derivatives ────────────────────────────────────────────────

test('GET /api/funding/!!! returns 400', async () => {
  const res = await request(app).get('/api/funding/' + encodeURIComponent('!!!'));
  assert.equal(res.status, 400);
});

// ── Metrics ────────────────────────────────────────────────────────────────

test('GET /metrics returns Prometheus text format', async () => {
  const res = await request(app).get('/metrics');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/plain/);
  // Sample of the surface we expose.
  assert.match(res.text, /^# HELP mp_uptime_seconds /m);
  assert.match(res.text, /^mp_module_enabled\{module="news"\} /m);
  assert.match(res.text, /^mp_module_stale\{module="liquidations"\} /m);
  // Spec compliance: no duplicate HELP/TYPE for the same metric name.
  const helpLines = res.text.match(/^# HELP \S+/gm) || [];
  const helpNames = helpLines.map(l => l.split(' ')[2]);
  assert.equal(new Set(helpNames).size, helpNames.length, 'duplicate HELP entries detected');
});
