import { fromBitmex } from './normalize.js';
import { createReconnectingWS } from '../utils/reconnectingWS.js';

const URL = 'wss://www.bitmex.com/realtime?subscribe=liquidation';

// BitMEX message envelope:
//   { table: "liquidation", action: "partial"|"insert"|"update"|"delete", data: [...] }
// We only process `insert` (new liquidation entered the book). `partial` is a
// snapshot of orders currently being filled — the safe stance is to skip it
// entirely: reprocessing on reconnect would double-count notional, and
// surviving a process restart would require persistent dedup we don't have.
// The cost is a brief warm-start gap; insert events follow within seconds.
// `update`/`delete` track lifecycle of pending orders and would double-count.

export function createBitmexClient({ log, onItem }) {
  const ws = createReconnectingWS({
    name: 'bitmex',
    url: URL,
    log,
    onMessage: (msg, { markEvent }) => {
      if (msg?.table !== 'liquidation' || !Array.isArray(msg.data)) return;
      if (msg.action !== 'insert') return; // skip partial/update/delete
      for (const item of msg.data) {
        const norm = fromBitmex(item);
        if (norm) { markEvent(); onItem(norm); }
      }
    },
  });

  return { start: ws.start, stop: ws.stop, status: ws.status };
}
