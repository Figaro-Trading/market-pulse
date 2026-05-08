// Prometheus exposition format renderer — no external dep.
// Pulls from each module's `status()` snapshot rather than instrumenting
// counters at the event-call sites; that keeps this tier non-invasive and
// guarantees /metrics never lies about what `/api/health` reports.
//
// Spec: https://prometheus.io/docs/instrumenting/exposition_formats/
// Each `# HELP` / `# TYPE` line MUST appear exactly once per metric name —
// hence we group all samples for a given name into a single block.

const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

function fmtLabels(labels) {
  if (!labels) return '';
  const parts = Object.entries(labels).map(([k, v]) => `${k}="${esc(v)}"`).join(',');
  return parts ? `{${parts}}` : '';
}

function emit(out, name, type, help, samples) {
  out.push(`# HELP ${name} ${help}`);
  out.push(`# TYPE ${name} ${type}`);
  for (const { value, labels } of samples) {
    const v = Number.isFinite(value) ? value : 0;
    out.push(`${name}${fmtLabels(labels)} ${v}`);
  }
}

const bool = (b) => (b ? 1 : 0);
const ageSec = (iso) => {
  if (!iso) return -1;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return -1;
  return Math.max(0, Math.round((Date.now() - t) / 1000));
};

export function renderMetrics(modules, { startedAtMs } = {}) {
  const out = [];
  const states = Object.fromEntries(
    Object.entries(modules).map(([k, m]) => [k, m.status()])
  );

  emit(out, 'mp_uptime_seconds', 'gauge', 'Process uptime in seconds', [
    { value: Math.round(process.uptime()) },
  ]);
  emit(out, 'mp_started_at_seconds', 'gauge', 'Process start time, unix seconds', [
    { value: startedAtMs ? Math.round(startedAtMs / 1000) : 0 },
  ]);

  // Per-module gauges, one block per metric name with one sample per module.
  emit(out, 'mp_module_enabled', 'gauge', '1 if the module has initialized',
    Object.entries(states).map(([k, s]) => ({ value: bool(s.enabled), labels: { module: k } })),
  );
  emit(out, 'mp_module_stale', 'gauge', '1 if the module has missed its expected refresh window',
    Object.entries(states).map(([k, s]) => ({ value: bool(s.stale), labels: { module: k } })),
  );

  // News.
  const n = states.news || {};
  emit(out, 'mp_news_items',                    'gauge',   'Items in the news cache',                                 [{ value: n.items }]);
  emit(out, 'mp_news_last_finnhub_count',       'gauge',   'Items returned by the last Finnhub call',                 [{ value: n.lastFinnhubCount }]);
  emit(out, 'mp_news_last_av_count',            'gauge',   'Items returned by the last Alpha Vantage call',           [{ value: n.lastAvCount }]);
  emit(out, 'mp_news_run_counter_total',        'counter', 'Number of refresh cycles since boot',                     [{ value: n.runCounter }]);
  emit(out, 'mp_news_last_refresh_age_seconds', 'gauge',   'Seconds since the last successful news refresh',          [{ value: ageSec(n.lastRefreshAt) }]);

  // Liquidations.
  const l = states.liquidations || {};
  emit(out, 'mp_liquidations_buffer_items',           'gauge',   'Items currently buffered',                                  [{ value: l.items }]);
  emit(out, 'mp_liquidations_received_total',         'counter', 'Total normalized events received since boot',               [{ value: l.totalReceived }]);
  emit(out, 'mp_liquidations_clients_connected',      'gauge',   'Connected exchange streams',                                [{ value: l.connectedClients }]);
  emit(out, 'mp_liquidations_clients_total',          'gauge',   'Configured exchange streams',                               [{ value: l.totalClients }]);
  emit(out, 'mp_liquidations_last_event_age_seconds', 'gauge',   'Seconds since the last event from any stream',              [{ value: ageSec(l.lastEventAt) }]);
  emit(out, 'mp_liquidations_buffer_capacity',        'gauge',   'Ring buffer capacity',                                      [{ value: l.bufferSize }]);

  // Quotes.
  const q = states.quotes || {};
  emit(out, 'mp_quotes_cache_size',     'gauge',   'Quote cache entries (positive + negative)', [{ value: q.cacheSize }]);
  emit(out, 'mp_quotes_inflight',       'gauge',   'In-flight upstream quote requests',         [{ value: q.inflight }]);
  emit(out, 'mp_quotes_requests_total', 'counter', 'Quote requests served',                     [{ value: q.requests }]);
  emit(out, 'mp_quotes_hits_total',     'counter', 'Cache hits',                                [{ value: q.hits }]);
  emit(out, 'mp_quotes_misses_total',   'counter', 'Cache misses',                              [{ value: q.misses }]);
  emit(out, 'mp_quotes_errors_total',   'counter', 'Upstream null results',                     [{ value: q.errors }]);

  // Derivatives.
  const d = states.derivatives || {};
  emit(out, 'mp_derivatives_symbols_cached',         'gauge', 'Symbols in the Bybit tickers snapshot',                  [{ value: d.symbolsCached }]);
  emit(out, 'mp_derivatives_last_fetch_age_seconds', 'gauge', 'Seconds since the last successful derivatives fetch',    [{ value: ageSec(d.lastFetchedAt) }]);

  return out.join('\n') + '\n';
}
