// Convert raw exchange payloads into the unified liquidation shape.
//
// Side mapping convention (industry-wide):
//   exchange "SELL" → liquidation engine SOLD to close a LONG  → side: "long"
//   exchange "BUY"  → liquidation engine BOUGHT to close a SHORT → side: "short"
// We always report the side of the LIQUIDATED position, not the order direction.

export function flipSide(exchangeSide) {
  const s = String(exchangeSide || '').toUpperCase();
  if (s === 'SELL') return 'long';
  if (s === 'BUY')  return 'short';
  return null;
}

export const makeId = (exchange, ts, symbol, side) =>
  `${exchange}-${ts}-${symbol}-${side}`;

// ── Binance USDT-M futures (fstream) ────────────────────────────────────────
// https://binance-docs.github.io/apidocs/futures/en/#liquidation-order-streams
export function fromBinanceFstream(payload) {
  const o = payload?.o;
  if (!o) return null;
  const side = flipSide(o.S);
  if (!side) return null;
  const symbol = String(o.s);
  const qty = Number(o.q);
  const price = Number(o.ap || o.p);
  const ts = Number(o.T) || Date.now();
  if (!Number.isFinite(qty) || !Number.isFinite(price) || qty <= 0 || price <= 0) return null;
  return {
    id: makeId('binance', ts, symbol, side),
    ts: new Date(ts).toISOString(),
    exchange: 'binance',
    symbol,
    side,
    qty,
    price,
    notional: qty * price,
    raw_symbol: symbol,
  };
}

// ── Binance COIN-M futures (dstream, inverse perp) ──────────────────────────
// qty is in CONTRACTS, each worth a fixed USD amount.
//   BTCUSD*: 100 USD per contract
//   others:  10 USD per contract
function coinMContractSize(symbol) {
  return symbol.startsWith('BTCUSD') ? 100 : 10;
}

export function fromBinanceDstream(payload) {
  const o = payload?.o;
  if (!o) return null;
  const side = flipSide(o.S);
  if (!side) return null;
  const rawSymbol = String(o.s);            // BTCUSD_PERP, ETHUSD_241227, …
  const symbol = rawSymbol.split('_')[0];   // BTCUSD, ETHUSD, …
  const qty = Number(o.q);
  const price = Number(o.ap || o.p);
  const ts = Number(o.T) || Date.now();
  if (!Number.isFinite(qty) || !Number.isFinite(price) || qty <= 0 || price <= 0) return null;
  return {
    id: makeId('binance', ts, rawSymbol, side),
    ts: new Date(ts).toISOString(),
    exchange: 'binance',
    symbol,
    side,
    qty,
    price,
    notional: qty * coinMContractSize(symbol),
    raw_symbol: rawSymbol,
  };
}

// ── Bybit V5 allLiquidation ────────────────────────────────────────────────
// https://bybit-exchange.github.io/docs/v5/websocket/public/all-liquidation
export function fromBybitV5(item) {
  if (!item) return null;
  const side = flipSide(item.S);
  if (!side) return null;
  const symbol = String(item.s);
  const qty = Number(item.v);
  const price = Number(item.p);
  const ts = Number(item.T) || Date.now();
  if (!Number.isFinite(qty) || !Number.isFinite(price) || qty <= 0 || price <= 0) return null;
  return {
    id: makeId('bybit', ts, symbol, side),
    ts: new Date(ts).toISOString(),
    exchange: 'bybit',
    symbol,
    side,
    qty,
    price,
    notional: qty * price,
    raw_symbol: symbol,
  };
}

// ── BitMEX liquidation ─────────────────────────────────────────────────────
// Inverse contracts (XBTUSD, ETHUSD, *futures): qty is denominated in USD,
// so qty IS the notional. Linear contracts use a multiplier.
function bitmexNotional(rawSymbol, qty, price) {
  if (rawSymbol === 'XBTUSD' || rawSymbol === 'ETHUSD') return qty;
  if (/^XBT[FGHJKMNQUVXZ]\d{2}$/.test(rawSymbol))       return qty;       // BTC dated futures
  if (rawSymbol === 'XBTUSDT')                          return qty * 0.001 * price;
  if (rawSymbol === 'ETHUSDT')                          return qty * 0.01 * price;
  return null; // unknown contract → caller should skip
}

export function fromBitmex(item) {
  if (!item) return null;
  const side = flipSide(item.side);
  if (!side) return null;
  const rawSymbol = String(item.symbol);
  const symbol = rawSymbol.replace(/^XBT/, 'BTC'); // human-friendly
  const qty = Number(item.leavesQty ?? item.size);
  const price = Number(item.price);
  if (!Number.isFinite(qty) || !Number.isFinite(price) || qty <= 0 || price <= 0) return null;
  const notional = bitmexNotional(rawSymbol, qty, price);
  if (notional == null) return null;
  const ts = Date.now(); // BitMEX liquidation rows have no per-item timestamp
  // BitMEX ships an `orderID` (uuid) per row — use it to make the id truly
  // unique. Two items in the same ms (typical of a `partial` batch) would
  // otherwise collapse onto the same id and be dropped by the dedup set.
  // Fall back to a synthetic suffix when the field is missing (test fixtures).
  const orderID = item.orderID || `${qty}-${price}`;
  return {
    id: `${makeId('bitmex', ts, rawSymbol, side)}-${orderID}`,
    ts: new Date(ts).toISOString(),
    exchange: 'bitmex',
    symbol,
    side,
    qty,
    price,
    notional,
    raw_symbol: rawSymbol,
  };
}
