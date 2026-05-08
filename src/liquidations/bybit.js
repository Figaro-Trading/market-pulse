import { fromBybitV5 } from './normalize.js';
import { createReconnectingWS } from '../utils/reconnectingWS.js';

const URL = 'wss://stream.bybit.com/v5/public/linear';
const PING_INTERVAL_MS = 20_000;
// If no pong arrives within this window, the TCP connection is silently
// black-holed and we must terminate to force a reconnect.
const PONG_TIMEOUT_MS = 40_000;
const SUBSCRIBE_BATCH = 10;   // Bybit caps args per `op:subscribe` message

// Bybit V5 has no firehose for liquidations — we subscribe per symbol.
// Default = 30 most active linear perps. Override with LIQ_BYBIT_SYMBOLS env.
// Some meme/older tickers use Bybit-specific naming:
//   PEPE → 1000PEPEUSDT, SHIB → 1000SHIBUSDT, MATIC → POLUSDT (post-rebrand).
const DEFAULT_SYMBOLS = [
  'BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','DOGEUSDT','ADAUSDT',
  'AVAXUSDT','DOTUSDT','LINKUSDT','LTCUSDT','BCHUSDT','ARBUSDT','OPUSDT',
  'APTUSDT','NEARUSDT','ATOMUSDT','POLUSDT','FILUSDT','ETCUSDT',
  'INJUSDT','SUIUSDT','TIAUSDT','SEIUSDT','TONUSDT','1000PEPEUSDT',
  'WLDUSDT','ORDIUSDT','AAVEUSDT','TRXUSDT','HBARUSDT',
];

export function createBybitClient({ log, onItem, symbols }) {
  const targetSymbols = (symbols && symbols.length) ? symbols : DEFAULT_SYMBOLS;

  const ws = createReconnectingWS({
    name: 'bybit',
    url: URL,
    log,
    onOpen: (sock) => {
      for (let i = 0; i < targetSymbols.length; i += SUBSCRIBE_BATCH) {
        const batch = targetSymbols.slice(i, i + SUBSCRIBE_BATCH)
          .map(s => `allLiquidation.${s}`);
        sock.send(JSON.stringify({ op: 'subscribe', args: batch }));
      }
    },
    onMessage: (msg, { markEvent }) => {
      if (msg?.op === 'subscribe') {
        if (!msg.success) log?.warn({ msg }, 'bybit subscribe rejected');
        return;
      }
      if (typeof msg.topic === 'string'
          && msg.topic.startsWith('allLiquidation.')
          && Array.isArray(msg.data)) {
        for (const item of msg.data) {
          const norm = fromBybitV5(item);
          if (norm) { markEvent(); onItem(norm); }
        }
      }
    },
    heartbeat: {
      intervalMs: PING_INTERVAL_MS,
      pongTimeoutMs: PONG_TIMEOUT_MS,
      ping: (sock) => sock.send(JSON.stringify({ op: 'ping' })),
      // Bybit V5 sometimes ships pong as `{ op: 'pong' }`, sometimes as
      // `{ ret_msg: 'pong', op: 'ping' }`. Accept both.
      isPong: (msg) => msg?.op === 'pong' || msg?.ret_msg === 'pong',
    },
  });

  return {
    start: ws.start,
    stop:  ws.stop,
    status: () => ({ ...ws.status(), symbols: targetSymbols.length }),
  };
}
