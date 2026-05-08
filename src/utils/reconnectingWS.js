// Single source of truth for the reconnecting-WebSocket pattern shared by
// the 3 liquidation clients (binance fstream/dstream, bybit, bitmex).
//
// Why factored: the connect/error/close/reconnect lifecycle was duplicated
// 3 times with subtle drift (Bybit had a pong watchdog, the others didn't;
// Binance used a class, Bybit/BitMEX used closures). Centralizing here means
// the next half-open-socket regression gets fixed once.
//
// Caller responsibilities:
//   - Parse the raw JSON via `onMessage(msg, { markEvent })` — call
//     `markEvent()` only when a real domain event was produced (not on
//     subscribe acks or other bookkeeping). The helper uses `lastEventAt` for
//     staleness reporting in /api/health, so over-reporting masks real outages.
//   - For exchanges that need a subscribe handshake (Bybit), pass `onOpen`.
//   - For exchanges with app-level keepalive (Bybit), pass `heartbeat`.

import WebSocket from 'ws';
import { safeErr } from './safeErr.js';

const DEFAULT_MAX_PAYLOAD = 1 << 20;   // 1 MiB — liquidation frames are < 1 KB
const DEFAULT_MAX_BACKOFF = 30_000;

// Exponential backoff with full jitter. Exposed for unit testing — pure
// function, deterministic when `random` is injected.
export function backoffDelay(attempt, { maxBackoff = DEFAULT_MAX_BACKOFF, random = Math.random } = {}) {
  const base = Math.min(maxBackoff, 1000 * 2 ** attempt);
  return Math.floor(base * (0.5 + random()));
}

export function createReconnectingWS({
  name,
  url,
  log,
  onMessage,
  onOpen,
  heartbeat,           // optional: { intervalMs, pongTimeoutMs, ping(ws), isPong(msg) }
  maxPayload = DEFAULT_MAX_PAYLOAD,
  maxBackoff = DEFAULT_MAX_BACKOFF,
}) {
  let ws = null;
  let attempt = 0;
  let connected = false;
  let lastEventAt = null;
  let shouldRun = false;
  let reconnecting = false;
  let pingTimer = null;
  let watchdogTimer = null;
  let lastPongAt = 0;

  const ctx = {
    markEvent: () => { lastEventAt = new Date().toISOString(); },
  };

  function startHeartbeat() {
    if (!heartbeat) return;
    stopHeartbeat();
    lastPongAt = Date.now();
    pingTimer = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) {
        try { heartbeat.ping(ws); } catch (e) { log?.warn({ stream: name, err: safeErr(e) }, 'heartbeat ping threw'); }
      }
    }, heartbeat.intervalMs);
    pingTimer.unref?.();
    // Watchdog tick = 1/4 of the timeout — gives 4 chances to detect a dead
    // socket before a pessimistic op gets noticeably blocked.
    watchdogTimer = setInterval(() => {
      if (Date.now() - lastPongAt > heartbeat.pongTimeoutMs) {
        log?.warn({ stream: name, since: Date.now() - lastPongAt }, 'pong watchdog: terminating');
        try { ws?.terminate(); } catch {}
      }
    }, Math.max(1000, Math.floor(heartbeat.pongTimeoutMs / 4)));
    watchdogTimer.unref?.();
  }
  function stopHeartbeat() {
    if (pingTimer)     { clearInterval(pingTimer);     pingTimer = null; }
    if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
  }

  function connect() {
    if (!shouldRun) return;
    log?.info({ stream: name }, 'connecting');
    const sock = new WebSocket(url, { maxPayload });
    ws = sock;

    sock.on('open', () => {
      connected = true;
      attempt = 0;
      log?.info({ stream: name }, 'connected');
      try { onOpen?.(sock); } catch (e) { log?.warn({ stream: name, err: safeErr(e) }, 'onOpen threw'); }
      startHeartbeat();
    });

    sock.on('message', (buf) => {
      let msg;
      try { msg = JSON.parse(String(buf)); }
      catch (e) { log?.warn({ stream: name, err: safeErr(e) }, 'parse error'); return; }
      // Heartbeat short-circuit: pong replies don't reach the caller.
      if (heartbeat?.isPong?.(msg)) { lastPongAt = Date.now(); return; }
      try { onMessage(msg, ctx); }
      catch (e) { log?.warn({ stream: name, err: safeErr(e) }, 'onMessage threw'); }
    });

    sock.on('close', () => {
      connected = false;
      stopHeartbeat();
      log?.warn({ stream: name }, 'closed');
      scheduleReconnect();
    });

    sock.on('error', (err) => {
      log?.warn({ stream: name, err: safeErr(err) }, 'error');
      // Trigger reconnect directly: a half-open or broken socket may never
      // emit `close`, so relying on that alone would strand the stream.
      scheduleReconnect();
      try { sock.terminate(); } catch {}
    });
  }

  function scheduleReconnect() {
    if (!shouldRun || reconnecting) return;
    reconnecting = true;
    attempt += 1;
    const delay = backoffDelay(attempt, { maxBackoff });
    log?.info({ stream: name, delay, attempt }, 'reconnecting');
    setTimeout(() => { reconnecting = false; connect(); }, delay).unref();
  }

  return {
    start() { shouldRun = true; connect(); },
    stop()  {
      shouldRun = false;
      stopHeartbeat();
      if (ws) try { ws.terminate(); } catch {}
    },
    status() { return { connected, lastEventAt, attempt }; },
  };
}
