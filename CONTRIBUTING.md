# Contributing to market-pulse

Thanks for your interest in contributing! This document explains how to set
up the project locally, propose changes, and what we expect in a pull
request.

By participating in this project you agree to abide by our
[Code of Conduct](CODE_OF_CONDUCT.md).

---

## Local development setup

```bash
git clone https://github.com/Figaro-Trading/market-pulse.git
cd market-pulse
npm install
cp .env.example .env
# fill in FINNHUB_KEY and ALPHAVANTAGE_KEY (free tiers — see README)
npm run dev   # node --watch — auto-restarts on file changes
```

**Requirements:** Node `>= 22` (the test runner relies on the native glob
pattern in `node --test`).

The frontend is served at `http://localhost:3001/` and consumes the
`/api/v1/*` endpoints documented in the [README](README.md#api).

---

## Branching and PR flow

1. Fork the repo and create a feature branch off `main`:
   ```bash
   git checkout -b feat/short-description
   ```
2. Make focused commits. Prefer [Conventional Commits](https://www.conventionalcommits.org/)
   prefixes (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`).
3. Run the local checks **before** pushing:
   ```bash
   npm run lint   # ESLint
   npm test       # node --test
   ```
4. Open a PR against `main`. Fill out the PR template (description, type
   of change, testing notes, checklist).
5. CI must be green before review (`test` and `security-scan` jobs).
6. At least one approving review is required before merge.

Do **not** force-push on `main`.

---

## Code style

- ESLint config at [eslint.config.js](eslint.config.js) — flat config, ESLint 9+.
- Two zones: `server.js + src/ + test/` (Node globals) and `public/`
  (browser globals). Keep frontend code free of Node-only APIs and vice
  versa.
- Run `npm run lint` locally; CI fails on warnings.

---

## Testing

- Unit + smoke tests live in [`test/`](test/).
- Use the built-in `node:test` runner — no Mocha, no Jest.
- New features should ship with tests covering the happy path and at
  least one error path.
- For network-dependent code, mock at the `fetch` boundary; do not rely
  on a working API key in the test environment.

```bash
npm test                       # full suite
node --test test/api.test.js   # single file
```

---

## What we look for in a PR

- A clear description of *why* the change exists, not just *what* it does.
- Tests covering the new behavior.
- An update to [CHANGELOG.md](CHANGELOG.md) under the `[Unreleased]`
  section if the change is user-visible (new endpoint, breaking config,
  fixed bug).
- Documentation updates in the README if you touch the public API
  surface, env vars, or quotas.

---

## Reporting bugs and requesting features

- **Bugs** → use the [bug report template](.github/ISSUE_TEMPLATE/bug_report.yml).
- **Features** → use the [feature request template](.github/ISSUE_TEMPLATE/feature_request.yml).
- **Security vulnerabilities** → see [SECURITY.md](SECURITY.md). Please do
  **not** open a public issue for security reports.

---

## License of contributions

By contributing, you agree that your contributions will be licensed under
the same [AGPL v3](LICENSE) as the rest of the project.
