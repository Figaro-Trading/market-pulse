# Security Policy

## Supported versions

This project is in early development. Only the latest `0.x` release on
the `main` branch receives fixes.

| Version | Supported |
|---|---|
| 0.x (latest `main`) | ✅ |
| Older tags | ❌ |

## Reporting a vulnerability

**Please do not open a public GitHub issue for vulnerabilities.**

Use the private [GitHub Security Advisory](https://github.com/Figaro-Trading/market-pulse/security/advisories/new)
form on this repository. This channel is private by default and only
visible to the maintainer until a fix is published.

Include in your report:

- A clear description of the issue and its impact.
- Steps to reproduce, or a proof-of-concept.
- The affected version (commit SHA or release tag).
- Any suggested mitigation.

## What to expect

- **Acknowledgment** within 72 hours.
- **Initial assessment** within 7 days, including severity rating.
- **Fix or mitigation** as soon as practical based on severity. Critical
  issues are prioritized.
- **Public disclosure** coordinated with the reporter — typically after
  a patch release is available.

## Scope

In scope:

- Code in this repository (`server.js`, `src/`, `public/`, `test/`).
- Handling of API credentials supplied via `.env` (Finnhub,
  Alpha Vantage, optional `NEWS_REFRESH_TOKEN`).
- Dependencies pinned in `package.json` / `package-lock.json`.
- The Docker image built from this repo's `Dockerfile`.

Out of scope:

- Third-party services consumed by this project (Finnhub, Alpha Vantage,
  Binance, Bybit, BitMEX, Yahoo, Nasdaq, Coinbase) — please report
  issues with those services directly to the respective providers.
- Self-hosted forks that have diverged from upstream.

## Defensive practices already in place

- **Helmet** sets standard HTTP hardening headers.
- **express-rate-limit** caps per-IP request rates with a stricter
  budget for outbound-fanout endpoints (`/api/quote/*`, `/api/quotes/*`).
- **Trivy** runs in CI on every push and fails on `HIGH`/`CRITICAL`
  findings in dependencies.
- **`.env` is git-ignored** and excluded from Docker builds via
  `.dockerignore`. Only `.env.example` (no values) is checked in.
- **Non-root container user** in the published Docker image.
