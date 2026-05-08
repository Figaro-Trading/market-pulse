# market-pulse

[![CI](https://github.com/Figaro-Trading/market-pulse/actions/workflows/ci.yml/badge.svg)](https://github.com/Figaro-Trading/market-pulse/actions/workflows/ci.yml)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen.svg)](package.json)

Complete backend for a trader-oriented financial news site. Aggregates **two
content families** behind a single API:

1. **News** — editorial articles via free commercial APIs (Finnhub +
   Alpha Vantage), normalized into a unified taxonomy (CRYPTO / STOCKS /
   FOREX / EARNINGS / GEOPOLITICAL / TECH / MACRO …).
2. **Live market events** — real-time feeds from **public, unauthenticated**
   exchange APIs (crypto liquidations, spot quotes, funding & open
   interest), with no proprietary data vendor required.

The whole thing runs as a single Node.js process exposing one API and one
frontend with unified tabs.

| Module | Source | Endpoint |
|---|---|---|
| News | Finnhub `/news`, Alpha Vantage `NEWS_SENTIMENT` | `GET /api/news`, `GET /api/news/:topic` |
| Crypto liquidations | Binance USDT-M & COIN-M, Bybit linear, BitMEX | `GET /api/liquidations`, `GET /api/liquidations/stats` |
| Spot quotes | Yahoo Finance (stocks), Nasdaq (fallback), Coinbase (crypto) | `GET /api/quote/:symbol` |
| Funding & open interest | Bybit `/v5/market/*` | `GET /api/funding/:symbol`, `GET /api/open-interest/:symbol` |

---

## Quick start

```bash
git clone https://github.com/Figaro-Trading/market-pulse.git
cd market-pulse
npm install
cp .env.example .env
#   FINNHUB_KEY=…           https://finnhub.io/register
#   ALPHAVANTAGE_KEY=…      https://www.alphavantage.co/support/#api-key
npm start                   # listens on :3001
curl http://localhost:3001/api/health
```

Demo page: `http://localhost:3001/`.

Requires **Node 22+** (uses native `node --test` glob support).

---

## API

### `GET /api/news`
Returns the merged Finnhub + Alpha Vantage news cache, deduplicated by URL,
sorted by `time_published` desc.

| param | default | description |
|---|---|---|
| `topic` | — | filter by unified taxonomy tag (see below) |
| `asset` | — | filter by mentioned ticker (`BTC`, `AAPL`, …) |
| `limit` | 200 | hard cap 500 |

Normalized item schema:
```json
{
  "title": "…",
  "summary": "…",
  "url": "https://…",
  "source": "Reuters",
  "source_domain": "reuters.com",
  "time_published": "2026-05-07T12:00:00.000Z",
  "topics": [{ "topic": "STOCKS" }, { "topic": "EARNINGS" }],
  "assets": ["AAPL", "MSFT"],
  "sentiment": "BULLISH",
  "sentiment_score": 0.31,
  "banner_image": "https://…",
  "source_api": "alphavantage",
  "fetchedAt": "2026-05-07T12:30:00.000Z"
}
```

### `GET /api/news/:topic`
Shorthand for `?topic=…`.

### `GET /api/liquidations`
| param | default | description |
|---|---|---|
| `min_notional` | `LIQ_MIN_NOTIONAL_USD` (1M) | USD notional threshold |
| `since` | — | ISO 8601 — events strictly after |
| `limit` | 200 | cap 1000 |
| `exchange` | all | `binance,bybit,bitmex` |
| `symbol` | — | normalized symbol (`BTCUSDT`) |

Item:
```json
{
  "id": "binance-1715077200000-BTCUSDT-long",
  "ts": "2026-05-07T12:00:00.000Z",
  "exchange": "binance",
  "symbol": "BTCUSDT",
  "side": "long",
  "qty": 134.55,
  "price": 63214.5,
  "notional": 8506011.4,
  "raw_symbol": "BTCUSDT"
}
```

### `GET /api/liquidations/stats`
Sliding stats (1h / 24h liquidated notional, top symbols, long/short split).

### `GET /api/quote/:symbol`
Automatic routing:
- `BTC`, `ETH`, `BTC-USD` → Coinbase
- `AAPL`, `TSLA`, … → Yahoo (Nasdaq fallback)

Cache TTL 10s.

### `GET /api/funding/:symbol`, `GET /api/open-interest/:symbol`
Bybit perp linear snapshot, refreshed server-side every 5 minutes.

### `GET /api/health`
Uptime + per-module status (cron OK, WS connected, last event received,
errors). Returns **HTTP 503** if a critical module (news, liquidations,
derivatives) is `enabled:false` or `stale`.

### `GET /livez`, `GET /readyz`
- `/livez` — always 200 as long as the process responds. For Kubernetes liveness.
- `/readyz` — 200 if all critical modules are ready and fresh, **503** otherwise. For Kubernetes readiness and the Docker `HEALTHCHECK`.

### `GET /metrics`
Prometheus format (text/plain). Per-module gauges + counters:
`mp_module_enabled{module=...}`, `mp_module_stale{module=...}`,
`mp_news_items`, `mp_liquidations_received_total`,
`mp_liquidations_last_event_age_seconds`, `mp_quotes_hits_total`, etc.

### Versioning
All routes above are also exposed under `/api/v1/...` (e.g.
`/api/v1/news`, `/api/v1/quote/:symbol`). Prefer this form on the client
side. The unversioned `/api/...` routes remain for compatibility; a future
`/api/v2` will introduce breaking changes.

---

## Unified taxonomy (UI tabs)

| Tab | Finnhub topics | Alpha Vantage topics | Bonus |
|---|---|---|---|
| `CRYPTO` | category=crypto | blockchain | + assets BTC/ETH/SOL/XRP |
| `LIQUIDATIONS` | — | — | real-time events (liquidations module) |
| `STOCKS` | category=general (with ticker) | financial_markets | |
| `FOREX` | category=forex | finance, economy_monetary | |
| `EARNINGS` | title regex | earnings | |
| `MERGER` | category=merger | mergers_and_acquisitions | |
| `IPO` | title regex | ipo | |
| `MACRO` | title regex | economy_macro, economy_fiscal | |
| `TECH` | title regex | technology | |
| `COMMODITIES` | tickers GOLD/OIL | energy_transportation | |
| `GEOPOLITICAL` | country/conflict regex | (rare) | |
| `REGULATION` | SEC regex | (rare) | |
| `ETF` | ETF regex | financial_markets | |
| `LIFE_SCIENCES` | — | life_sciences | |
| `MANUFACTURING` | — | manufacturing | |
| `REAL_ESTATE` | — | real_estate | |
| `RETAIL_WHOLESALE` | — | retail_wholesale | |

---

## Architecture

```
                Cron node-cron                       Public exchange WSS
                (NEWS_REFRESH_CRON)                 (always-on connections)
                       │                                     │
              ┌────────┴─────────┐               ┌───────────┴───────────┐
              ▼                  ▼               ▼          ▼            ▼
      ┌──────────────┐  ┌──────────────┐  ┌──────────┐ ┌──────────┐ ┌──────────┐
      │ Finnhub      │  │ Alpha Vantage│  │ Binance  │ │ Bybit    │ │ BitMEX   │
      │ /api/v1/news │  │ NEWS_SENTI…  │  │ liq WS   │ │ liq WS   │ │ liq WS   │
      └──────┬───────┘  └──────┬───────┘  └────┬─────┘ └────┬─────┘ └────┬─────┘
             └──────┬──────────┘                └──────┬─────┴────────────┘
                    ▼                                  ▼
          ┌──────────────────┐                ┌──────────────────┐
          │ src/news         │                │ src/liquidations │
          │ normalize+cache  │                │ normalize+ring   │
          └────────┬─────────┘                └────────┬─────────┘
                   │                                   │
                   ▼                                   ▼
                ┌─────────────────────────────────────────────┐
                │           Express (server.js)               │
                │  /api/news    /api/liquidations             │   ← polled
                │  /api/quote   /api/funding /api/open-int    │
                │  /api/health                                │
                └────────────────────┬────────────────────────┘
                                     │
                                     ▼
                ┌─────────────────────────────────────────────┐
                │   public/  — single UI with unified tabs    │
                │   (ALL · CRYPTO · STOCKS · LIQUIDATIONS …)  │
                │   + quote chips on news cards               │
                └─────────────────────────────────────────────┘
```

Single Node 22+ process, no DB. ~80 MB RAM idle. Restart = loss of the
liquidations buffer (max 24-48h depending on `LIQ_BUFFER_SIZE`); news are
re-fetched on the next cron tick.

---

## Phases

| Phase | Scope | Status |
|---|---|---|
| 1 | Skeleton + `/api/health` | ✅ |
| 1bis | Scope correction (env keys + node-cron + module registry + README) | ✅ |
| 2 | News module: Finnhub + Alpha Vantage + topics + normalize + cron + `/api/news` `/api/news/:topic` | ✅ |
| 3 | Liquidations module: ring buffer + WS Binance/Bybit/BitMEX + normalize | ✅ |
| 4 | `/api/liquidations` + `/api/liquidations/stats` | ✅ |
| 5 | Quotes module + `/api/quote/:symbol` | ✅ |
| 6 | Derivatives module + `/api/funding`, `/api/open-interest` | ✅ |
| 7 | Unified frontend (tabs, sentiment badges, quote chips, liquidations card) | ✅ |
| 8 | LICENSE AGPL-3.0 + GitHub Actions CI + tests + Dockerfile | ✅ |
| 9 | Production hardening: helmet, rate-limit, validation, auth refresh, `/livez` + `/readyz`, staleness, WS robustness (jitter, pong-watchdog, BitMEX dedup), Prometheus `/metrics`, ESLint, Trivy, `/api/v1` versioning, integration tests | ✅ |

---

## Configuration

Everything via `.env` (see [.env.example](.env.example)).

| var | default | role |
|---|---|---|
| `PORT` | `3001` | HTTP port |
| `LOG_LEVEL` | `info` | pino level |
| `FINNHUB_KEY` | — | Finnhub key (free) |
| `ALPHAVANTAGE_KEY` | — | Alpha Vantage key (free) |
| `NEWS_REFRESH_CRON` | `*/30 * * * *` | news refresh cron |
| `FINNHUB_CATEGORIES` | `general,forex,crypto,merger` | Finnhub categories fetched |
| `AV_RUN_EVERY` | `2` | Alpha Vantage hit every N cron runs |
| `LIQ_MIN_NOTIONAL_USD` | `1000000` | default `/api/liquidations` threshold |
| `LIQ_BUFFER_SIZE` | `50000` | ring buffer capacity (capped at 200,000) |
| `LIQ_EXCHANGES` | `binance,bybit,bitmex` | enabled exchanges |
| `QUOTE_CACHE_TTL_MS` | `10000` | quote cache TTL |
| `DERIV_REFRESH_MS` | `300000` | funding/OI refresh |
| `DERIV_SYMBOLS` | `BTCUSDT,ETHUSDT,SOLUSDT` | tracked Bybit symbols |
| `NEWS_REFRESH_TOKEN` | — | bearer token for `POST /api/news/refresh`; empty = endpoint disabled (503). **Set in production.** |

---

## Quotas

| API | Free tier limit | Default strategy |
|---|---|---|
| Finnhub | 60 req/min, ~30d history | 4 categories × 48 cycles/day = 192 req/day ✅ |
| Alpha Vantage | 25 req/day, 5 req/min | `AV_RUN_EVERY=2` → 24 req/day ✅ |
| Binance/Bybit/BitMEX WS | none | always-on, exponential reconnect |
| Yahoo / Nasdaq / Coinbase REST | undocumented | TTL 10s + 1 req/symbol/sec max |
| Bybit REST funding/OI | 600 req/5s/IP | 3 symbols × 12/h = 36 req/h ✅ |

---

## Public sources used (summary)

REST:
- `https://finnhub.io/api/v1/news?category=…&token=…`
- `https://www.alphavantage.co/query?function=NEWS_SENTIMENT&topics=…&apikey=…`
- `https://api.bybit.com/v5/market/{instruments-info,funding/history,open-interest}`
- `https://query1.finance.yahoo.com/v7/finance/quote`
- `https://api.nasdaq.com/api/quote/{symbol}/info?assetclass=stocks`
- `https://api.coinbase.com/v2/prices/{pair}/spot`

WebSocket:
- `wss://fstream.binance.com/ws/!forceOrder@arr` (USDT-M futures)
- `wss://dstream.binance.com/ws/!forceOrder@arr` (COIN-M futures)
- `wss://stream.bybit.com/v5/public/linear` (Bybit linear)
- `wss://www.bitmex.com/realtime?subscribe=liquidation`

---

## Acknowledgments / Data providers

This project would not exist without the following public data sources.
Please review and respect each provider's terms before redistributing data.

**News providers (require API key):**
- [Finnhub — sign up](https://finnhub.io/register) — [Terms](https://finnhub.io/terms-of-service)
- [Alpha Vantage — get key](https://www.alphavantage.co/support/#api-key) — [Terms](https://www.alphavantage.co/terms_of_service/)

**Market data (public unauthenticated endpoints):**
- [Yahoo Finance](https://finance.yahoo.com/) (chart v8) — [Terms](https://policies.yahoo.com/us/en/yahoo/terms/index.htm)
- [Nasdaq](https://www.nasdaq.com/) (api.nasdaq.com/api/quote) — [Terms](https://www.nasdaq.com/terms-of-service)
- [Coinbase](https://www.coinbase.com/) (api.coinbase.com/v2/prices) — [Terms](https://www.coinbase.com/legal/user_agreement)
- [Binance](https://www.binance.com/) (fstream + dstream WebSocket) — [Terms](https://www.binance.com/en/terms)
- [Bybit](https://www.bybit.com/) (REST tickers + WS allLiquidation) — [Terms](https://www.bybit.com/en/help-center/article/Terms-of-Service)
- [BitMEX](https://www.bitmex.com/) (WebSocket realtime liquidation) — [Terms](https://www.bitmex.com/app/terms)

---

## Contributing

Contributions are welcome. Before opening a PR, please read:

- [CONTRIBUTING.md](CONTRIBUTING.md) — dev setup, code style, PR flow
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) — Contributor Covenant v2.1
- [SECURITY.md](SECURITY.md) — how to report a vulnerability privately
- [CHANGELOG.md](CHANGELOG.md) — release history

Run `npm run lint && npm test` before pushing — CI runs the same checks.

---

## Legal notes

Article contents remain the property of their respective publishers
(Reuters, CoinDesk, CNBC, MarketBeat, …). This platform only exposes
**title, source, timestamp, short summary and link** — never the full text.

Yahoo Finance commercial usage without an official data feed is a
**gray area** — validate before any paid-production deployment.

All sentiment badges, funding/open-interest metrics and the liquidations
feed are indicative and **do not constitute investment advice**, a
recommendation, or a solicitation to buy or sell any financial instrument.
Always verify with an official source before any decision.

---

## License

**AGPL v3** — strong copyleft. See [LICENSE](LICENSE).

In practice:
- ✅ You can use, modify, and fork it.
- ✅ You can host it for personal or internal use.
- ⚠️ If you **publish a modified version** or **offer it as a SaaS to third
  parties**, you must publish your source code under AGPL.
- ⚠️ No proprietary rebadging.

For a commercial license (out of AGPL), contact the author.

---

## Docker

```bash
docker build -t market-pulse .
docker run -p 3001:3001 --env-file .env market-pulse
```

Multi-stage Node 22 alpine image, ~120 MB, integrated `/api/health`
healthcheck, runs as a non-root user.
