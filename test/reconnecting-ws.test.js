// Pure-function tests for the WS reconnect helper. No real socket — that's
// covered by the boot-time integration test (server.js connects all 4 WS
// streams and /api/health reports them connected within 2s).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backoffDelay } from '../src/utils/reconnectingWS.js';

test('backoffDelay: deterministic with injected random', () => {
  // attempt=1 → base=2000ms, jitter=0.5 → 1000ms (lower bound)
  assert.equal(backoffDelay(1, { random: () => 0 }), 1000);
  // attempt=1 → base=2000ms, jitter=1.0 → 3000ms (upper bound)
  assert.equal(backoffDelay(1, { random: () => 1 }), 3000);
});

test('backoffDelay: caps at maxBackoff regardless of attempt', () => {
  // attempt=20 would be 1000 × 2^20 = ~1.05B ms; cap=30s → 15-45k post-jitter
  const d = backoffDelay(20, { maxBackoff: 30_000, random: () => 0.5 });
  assert.equal(d, 30_000);
  // High jitter still respects cap × jitter (cap is on base, not output).
  const dHi = backoffDelay(20, { maxBackoff: 30_000, random: () => 1 });
  assert.equal(dHi, 45_000);
});

test('backoffDelay: monotonic-ish growth across early attempts', () => {
  // With identical jitter, attempt N+1 ≥ attempt N (until cap).
  const r = () => 0.5;
  const d1 = backoffDelay(1, { random: r });
  const d2 = backoffDelay(2, { random: r });
  const d3 = backoffDelay(3, { random: r });
  assert.ok(d1 < d2 && d2 < d3);
  assert.equal(d1, 2000);
  assert.equal(d2, 4000);
  assert.equal(d3, 8000);
});
