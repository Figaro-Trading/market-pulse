// Unified news taxonomy.
//
// Every news item ends up tagged with zero or more of these topics:
//   ALL, CRYPTO, STOCKS, FOREX, EARNINGS, MERGER, IPO, MACRO, TECH,
//   COMMODITIES, GEOPOLITICAL, REGULATION, ETF, BLOCKCHAIN,
//   LIFE_SCIENCES, MANUFACTURING, REAL_ESTATE, RETAIL_WHOLESALE,
//   ENERGY_TRANSPORTATION
//
// LIQUIDATIONS is a separate stream (not derived from headlines) and is
// surfaced by src/liquidations/, not here.

const FINNHUB_CATEGORY_MAP = {
  crypto:  ['CRYPTO'],
  forex:   ['FOREX'],
  merger:  ['MERGER'],
  general: ['STOCKS'],
};

const ALPHA_TOPIC_MAP = {
  blockchain:               ['BLOCKCHAIN', 'CRYPTO'],
  earnings:                 ['EARNINGS'],
  ipo:                      ['IPO'],
  mergers_and_acquisitions: ['MERGER'],
  financial_markets:        ['STOCKS', 'ETF'],
  economy_fiscal:           ['MACRO'],
  economy_monetary:         ['MACRO', 'FOREX'],
  economy_macro:            ['MACRO'],
  energy_transportation:    ['COMMODITIES', 'ENERGY_TRANSPORTATION'],
  finance:                  ['FOREX'],
  life_sciences:            ['LIFE_SCIENCES'],
  manufacturing:            ['MANUFACTURING'],
  real_estate:              ['REAL_ESTATE'],
  retail_wholesale:         ['RETAIL_WHOLESALE'],
  technology:               ['TECH'],
};

const KEYWORD_RULES = [
  { rx: /\b(SEC|regulation|regulator|ban|comply|compliance)\b/i, topic: 'REGULATION' },
  { rx: /\bETFs?\b/,                                              topic: 'ETF' },
  { rx: /\b(Iran|Russia|Ukraine|war|sanction|conflict|Israel|Gaza|NATO)\b/i, topic: 'GEOPOLITICAL' },
  { rx: /\b(AI|artificial intelligence|chip|chipmaker|semiconductor|GPU)\b/i, topic: 'TECH' },
  { rx: /\b(gold|silver|oil|crude|brent|wheat|copper|natural gas)\b/i,        topic: 'COMMODITIES' },
  { rx: /\b(Q[1-4]\s*\d{2,4}|earnings|quarterly results|EPS)\b/i,             topic: 'EARNINGS' },
  { rx: /\bIPO\b/,                                                            topic: 'IPO' },
];

const TICKER_RULES = [
  { rx: /\b(BTC|bitcoin)\b/i,                  asset: 'BTC' },
  { rx: /\b(ETH|ethereum|ether)\b/i,           asset: 'ETH' },
  { rx: /\b(XRP|ripple)\b/i,                   asset: 'XRP' },
  { rx: /\b(SOL|solana)\b/i,                   asset: 'SOL' },
  { rx: /\b(DOGE|dogecoin)\b/i,                asset: 'DOGE' },
  { rx: /\bgold\b/i,                           asset: 'GOLD' },
  { rx: /\bsilver\b/i,                         asset: 'SILVER' },
  { rx: /\b(oil|crude|brent|wti)\b/i,          asset: 'OIL' },
  { rx: /\b(EUR\/USD|euro\b)/i,                asset: 'EUR' },
  { rx: /\b(JPY|yen)\b/i,                      asset: 'JPY' },
];

export function deriveTopics({ source_api, finnhubCategory, alphaTopics, title }) {
  const set = new Set();
  if (source_api === 'finnhub') {
    (FINNHUB_CATEGORY_MAP[finnhubCategory] || []).forEach(t => set.add(t));
  } else if (source_api === 'alphavantage') {
    (alphaTopics || []).forEach(({ topic }) => {
      (ALPHA_TOPIC_MAP[topic] || []).forEach(t => set.add(t));
    });
  }
  const text = title || '';
  for (const { rx, topic } of KEYWORD_RULES) {
    if (rx.test(text)) set.add(topic);
  }
  return [...set];
}

export function extractAssets({ related, title, tickerSentiment }) {
  const set = new Set();
  if (related && typeof related === 'string') {
    related.split(',').map(s => s.trim()).filter(Boolean).forEach(t => set.add(t.toUpperCase()));
  }
  if (Array.isArray(tickerSentiment)) {
    tickerSentiment.forEach(t => { if (t?.ticker) set.add(t.ticker.toUpperCase()); });
  }
  const text = title || '';
  for (const { rx, asset } of TICKER_RULES) {
    if (rx.test(text)) set.add(asset);
  }
  return [...set];
}

export const ALL_TOPICS = [
  'CRYPTO', 'STOCKS', 'FOREX', 'EARNINGS', 'MERGER', 'IPO', 'MACRO', 'TECH',
  'COMMODITIES', 'GEOPOLITICAL', 'REGULATION', 'ETF', 'BLOCKCHAIN',
  'LIFE_SCIENCES', 'MANUFACTURING', 'REAL_ESTATE', 'RETAIL_WHOLESALE',
  'ENERGY_TRANSPORTATION',
];
