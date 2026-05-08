// Parse a numeric env var without the `Number(env) || default` footgun.
//
// `Number("0") || 30` silently becomes 30 — preventing operators from setting
// a deliberate zero. `Number("-5") || 30` returns -5, leaking a negative into
// downstream code that then crashes opaquely (e.g. express-rate-limit).
//
// This helper:
//   - returns `fallback` only when the var is absent, empty, or unparseable
//   - preserves a deliberate `0` and lets callers clamp via Math.max/min so
//     the bound is visible at the call site.
export function numEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}
