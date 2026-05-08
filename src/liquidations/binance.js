import { fromBinanceFstream, fromBinanceDstream } from './normalize.js';
import { createReconnectingWS } from '../utils/reconnectingWS.js';

const FSTREAM_URL = 'wss://fstream.binance.com/ws/!forceOrder@arr';
const DSTREAM_URL = 'wss://dstream.binance.com/ws/!forceOrder@arr';
// Binance pings every 3 min and the `ws` library responds with pong
// automatically — no app-level heartbeat needed.

function makeStream(name, url, parser, log, onItem) {
  return createReconnectingWS({
    name,
    url,
    log,
    onMessage: (msg, { markEvent }) => {
      const item = parser(msg);
      if (item) { markEvent(); onItem(item); }
    },
  });
}

export function createBinanceClient({ log, onItem, enableCoinM = true }) {
  const fstream = makeStream('fstream', FSTREAM_URL, fromBinanceFstream, log, onItem);
  const dstream = enableCoinM
    ? makeStream('dstream', DSTREAM_URL, fromBinanceDstream, log, onItem)
    : null;

  return {
    start: () => { fstream.start(); dstream?.start(); },
    stop:  () => { fstream.stop();  dstream?.stop();  },
    status: () => ({
      fstream: fstream.status(),
      dstream: dstream?.status() ?? null,
    }),
  };
}
