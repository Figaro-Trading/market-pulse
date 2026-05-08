# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-05-08

### Added
- Initial public release.
- News module: Finnhub + Alpha Vantage aggregation, unified taxonomy
  (CRYPTO / STOCKS / FOREX / EARNINGS / GEOPOLITICAL / TECH / MACRO …),
  cron refresh, dedup by URL.
- Liquidations module: real-time WebSocket feeds from Binance USDT-M &
  COIN-M, Bybit linear, BitMEX. In-memory ring buffer with normalized
  schema and sliding stats (1h / 24h notional, top symbols, long/short
  split).
- Quotes module: routing between Yahoo (stocks, with Nasdaq fallback)
  and Coinbase (crypto). 10-second TTL cache.
- Derivatives module: Bybit perp linear funding rate and open interest,
  refreshed every 5 minutes.
- Frontend (`public/`): unified UI with ticker bar, KPI strip, sidebar
  filters, editorial + standard news cards, Symbol Spotlight, sentiment
  sparkline (client-side aggregated, 1h/4h/24h windows), live
  liquidations feed, funding heatmap, health dot.
- Production hardening: Helmet, per-IP rate limits, request validation,
  bearer token for `POST /api/news/refresh`, `/livez` + `/readyz`
  endpoints, Prometheus `/metrics`, ESLint, GitHub Actions CI with
  Trivy security scan, multi-stage Docker image (Node 22 alpine,
  non-root user, integrated `/api/health` healthcheck).
- API versioning: `/api/v1/*` routes mirror the unversioned `/api/*`
  surface; the rewriter at `server.js:184` is the single point to swap
  for a future `/api/v2`.
- AGPL-3.0-or-later license.
- Professional documentation set: README with badges, CONTRIBUTING,
  CODE_OF_CONDUCT (Contributor Covenant v2.1), SECURITY (vulnerability
  reporting via GitHub Security Advisory), issue and pull request
  templates, Dependabot config, CODEOWNERS.

[Unreleased]: https://github.com/Figaro-Trading/market-pulse/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Figaro-Trading/market-pulse/releases/tag/v0.1.0
