// Single source of truth for error sanitization across the codebase.
//
// Why: fetch / abort / WebSocket errors routinely embed full URLs in their
// `.message` (e.g. `?token=…`, `?apikey=…`). Exposing those strings via
// /api/health, structured logs, or pino's default error serializer would leak
// secrets. We keep `code` (system errno like ENOTFOUND) or `name` (AbortError,
// FetchError, …) — both are safe and useful.
export const safeErr = (e) => e?.code || e?.name || 'Error';
