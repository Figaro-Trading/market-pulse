// Smoke tests for pure functions — no network, no WS, no Express.
// Run with: npm test  (uses node --test)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  flipSide,
  fromBinanceFstream,
  fromBinanceDstream,
  fromBybitV5,
  fromBitmex,
} from '../src/liquidations/normalize.js';

import { deriveTopics, extractAssets, ALL_TOPICS } from '../src/news/topics.js';

// ── Liquidations: side mapping ────────────────────────────────────────────

test('flipSide: SELL → long, BUY → short, garbage → null', () => {
  assert.equal(flipSide('SELL'), 'long');
  assert.equal(flipSide('sell'), 'long');
  assert.equal(flipSide('BUY'),  'short');
  assert.equal(flipSide(''),     null);
  assert.equal(flipSide(null),   null);
  assert.equal(flipSide('FOO'),  null);
});

// ── Liquidations: Binance USDT-M ──────────────────────────────────────────

test('fromBinanceFstream: long liquidation', () => {
  const out = fromBinanceFstream({
    o: { s: 'BTCUSDT', S: 'SELL', q: '2', ap: '60000', T: 1715000000000 },
  });
  assert.ok(out, 'should normalize');
  assert.equal(out.exchange, 'binance');
  assert.equal(out.symbol, 'BTCUSDT');
  assert.equal(out.side, 'long');
  assert.equal(out.qty, 2);
  assert.equal(out.price, 60000);
  assert.equal(out.notional, 120000);
  assert.equal(out.raw_symbol, 'BTCUSDT');
  assert.match(out.id, /^binance-1715000000000-BTCUSDT-long$/);
});

test('fromBinanceFstream: short liquidation, falls back to o.p when ap missing', () => {
  const out = fromBinanceFstream({
    o: { s: 'ETHUSDT', S: 'BUY', q: '10', p: '3000', T: 1715000000000 },
  });
  assert.equal(out.side, 'short');
  assert.equal(out.price, 3000);
  assert.equal(out.notional, 30000);
});

test('fromBinanceFstream: rejects invalid payloads', () => {
  assert.equal(fromBinanceFstream(null), null);
  assert.equal(fromBinanceFstream({}), null);
  assert.equal(fromBinanceFstream({ o: { s: 'BTCUSDT', S: 'SELL', q: '0', ap: '60000' } }), null);
  assert.equal(fromBinanceFstream({ o: { s: 'BTCUSDT', S: 'WHAT', q: '1', ap: '1' } }), null);
});

// ── Liquidations: Binance COIN-M (inverse perp) ───────────────────────────

test('fromBinanceDstream: BTCUSD uses 100 USD per contract', () => {
  const out = fromBinanceDstream({
    o: { s: 'BTCUSD_PERP', S: 'SELL', q: '50', ap: '60000', T: 1715000000000 },
  });
  assert.ok(out);
  assert.equal(out.symbol, 'BTCUSD');
  assert.equal(out.notional, 50 * 100); // 50 contracts × $100 = $5,000
  assert.equal(out.raw_symbol, 'BTCUSD_PERP');
});

test('fromBinanceDstream: ETHUSD uses 10 USD per contract', () => {
  const out = fromBinanceDstream({
    o: { s: 'ETHUSD_PERP', S: 'BUY', q: '500', ap: '3000' },
  });
  assert.equal(out.notional, 500 * 10); // 500 × $10 = $5,000
  assert.equal(out.side, 'short');
});

// ── Liquidations: Bybit V5 ────────────────────────────────────────────────

test('fromBybitV5: notional = qty × price', () => {
  const out = fromBybitV5({ s: 'SOLUSDT', S: 'Sell', v: '100', p: '160', T: 1715000000000 });
  assert.equal(out.exchange, 'bybit');
  assert.equal(out.side, 'long');
  assert.equal(out.notional, 16000);
});

// ── Liquidations: BitMEX ──────────────────────────────────────────────────

test('fromBitmex: XBTUSD inverse, qty IS USD notional', () => {
  const out = fromBitmex({ symbol: 'XBTUSD', side: 'Sell', price: 60000, leavesQty: 5_000_000 });
  assert.ok(out);
  assert.equal(out.symbol, 'BTCUSD');         // XBT → BTC rename
  assert.equal(out.raw_symbol, 'XBTUSD');
  assert.equal(out.side, 'long');
  assert.equal(out.notional, 5_000_000);      // qty already in USD
});

test('fromBitmex: linear XBTUSDT applies 0.001 multiplier', () => {
  const out = fromBitmex({ symbol: 'XBTUSDT', side: 'Buy', price: 60000, leavesQty: 1000 });
  assert.equal(out.notional, 1000 * 0.001 * 60000); // 60,000
  assert.equal(out.side, 'short');
});

test('fromBitmex: unknown contract → null', () => {
  const out = fromBitmex({ symbol: 'UNKNOWNUSD', side: 'Sell', price: 100, leavesQty: 50 });
  assert.equal(out, null);
});

// ── News: topic derivation ────────────────────────────────────────────────

test('deriveTopics: Finnhub crypto category', () => {
  const topics = deriveTopics({
    source_api: 'finnhub',
    finnhubCategory: 'crypto',
    title: 'Bitcoin rallies to new high',
  });
  assert.ok(topics.includes('CRYPTO'));
});

test('deriveTopics: Alpha Vantage earnings + financial_markets', () => {
  const topics = deriveTopics({
    source_api: 'alphavantage',
    alphaTopics: [{ topic: 'earnings' }, { topic: 'financial_markets' }],
    title: 'Apple Q3 results beat expectations',
  });
  assert.ok(topics.includes('EARNINGS'));
  assert.ok(topics.includes('STOCKS'));
  assert.ok(topics.includes('ETF'));
});

test('deriveTopics: keyword regex picks up GEOPOLITICAL', () => {
  const topics = deriveTopics({
    source_api: 'finnhub',
    finnhubCategory: 'general',
    title: 'Iran sanctions tighten on oil exports',
  });
  assert.ok(topics.includes('GEOPOLITICAL'));
  assert.ok(topics.includes('COMMODITIES'));
});

test('deriveTopics: REGULATION + ETF detection from headlines', () => {
  const t1 = deriveTopics({ source_api: 'finnhub', finnhubCategory: 'general', title: 'SEC investigates broker' });
  const t2 = deriveTopics({ source_api: 'finnhub', finnhubCategory: 'general', title: 'BlackRock files new ETF' });
  assert.ok(t1.includes('REGULATION'));
  assert.ok(t2.includes('ETF'));
});

// ── News: asset extraction ────────────────────────────────────────────────

test('extractAssets: Finnhub related field + title heuristics', () => {
  const assets = extractAssets({
    related: 'AAPL,MSFT',
    title: 'Bitcoin and Ethereum rally',
  });
  assert.ok(assets.includes('AAPL'));
  assert.ok(assets.includes('MSFT'));
  assert.ok(assets.includes('BTC'));
  assert.ok(assets.includes('ETH'));
});

test('extractAssets: Alpha Vantage ticker_sentiment array', () => {
  const assets = extractAssets({
    title: 'Tech roundup',
    tickerSentiment: [{ ticker: 'NVDA' }, { ticker: 'TSLA' }],
  });
  assert.ok(assets.includes('NVDA'));
  assert.ok(assets.includes('TSLA'));
});

// ── News: taxonomy completeness ───────────────────────────────────────────

test('ALL_TOPICS lists every unified topic', () => {
  const expected = [
    'CRYPTO','STOCKS','FOREX','EARNINGS','MERGER','IPO','MACRO','TECH',
    'COMMODITIES','GEOPOLITICAL','REGULATION','ETF','BLOCKCHAIN',
    'LIFE_SCIENCES','MANUFACTURING','REAL_ESTATE','RETAIL_WHOLESALE',
    'ENERGY_TRANSPORTATION',
  ];
  for (const t of expected) assert.ok(ALL_TOPICS.includes(t), `missing ${t}`);
});
