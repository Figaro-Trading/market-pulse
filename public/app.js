// Market Pulse — frontend runtime.
// Pulls data from the /api/v1 surface, renders the design-system components
// (ticker, KPI strip, sidebar filters, feed, spotlight, sentiment chart,
// live liquidations, funding heatmap, health dot).

const API = '/api/v1';

const TICKER_SYMBOLS = ['BTC', 'ETH', 'SOL', 'SPY', 'QQQ', 'AAPL', 'NVDA', 'TSLA'];

const TOPIC_GROUPS = [
  { label: 'Markets', tabs: [
    { val: 'ALL',     label: 'All news' },
    { val: 'CRYPTO',  label: 'Crypto' },
    { val: 'STOCKS',  label: 'Stocks' },
    { val: 'FOREX',   label: 'Forex' },
    { val: 'MACRO',   label: 'Macro' },
  ]},
  { label: 'Events', tabs: [
    { val: 'EARNINGS', label: 'Earnings' },
    { val: 'GEO',      label: 'Geopolitical' },
    { val: 'ENERGY',   label: 'Energy' },
    { val: 'TECH',     label: 'Tech' },
  ]},
];

// Backend unified topics (uppercase, see src/news/topics.js → ALL_TOPICS) →
// frontend chip code (also drives sidebar filter buckets).
const TOPIC_REMAP = {
  CRYPTO: 'CRYPTO',
  BLOCKCHAIN: 'CRYPTO',
  STOCKS: 'STOCKS',
  MERGER: 'STOCKS',
  IPO: 'STOCKS',
  ETF: 'STOCKS',
  MANUFACTURING: 'STOCKS',
  REAL_ESTATE: 'STOCKS',
  LIFE_SCIENCES: 'STOCKS',
  RETAIL_WHOLESALE: 'STOCKS',
  FOREX: 'FOREX',
  MACRO: 'MACRO',
  TECH: 'TECH',
  COMMODITIES: 'ENERGY',
  ENERGY_TRANSPORTATION: 'ENERGY',
  GEOPOLITICAL: 'GEO',
  REGULATION: 'GEO',
  EARNINGS: 'EARNINGS',
};

const INTERVALS = {
  news: 5 * 60_000,
  liquidations: 10_000,
  liqStats: 30_000,
  derivatives: 5 * 60_000,
  health: 30_000,
  quotes: 60_000,
  sentimentBucket: 60_000,
};

const state = {
  news: [],
  liqs: [],
  liqStats: null,
  derivs: { list: [] },
  health: null,
  quotes: {},
  filter: 'ALL',
  search: '',
  minLiq: 0,
  sentimentWindow: '1h',
  sentimentBuffer: [],
  seen: new Set(),
};

// ─── Fetch helpers ──────────────────────────────────────────────────────────

async function safeFetch(url, fallback = null) {
  try {
    const r = await fetch(url);
    if (!r.ok) return fallback;
    return await r.json();
  } catch {
    return fallback;
  }
}

async function refreshNews() {
  const items = await safeFetch(`${API}/news?limit=500`, []);
  if (Array.isArray(items)) state.news = items;
  recordSentimentBucket();
  renderKpis();
  renderSidebar();
  renderSpotlight();
  renderFeed();
}

async function refreshLiquidations() {
  const items = await safeFetch(`${API}/liquidations?limit=200`, []);
  if (Array.isArray(items)) state.liqs = items;
  renderLiqs();
}

async function refreshLiqStats() {
  state.liqStats = await safeFetch(`${API}/liquidations/stats`, null);
  renderKpis();
}

async function refreshDerivatives() {
  const d = await safeFetch(`${API}/derivatives`, null);
  if (d && Array.isArray(d.list)) state.derivs = d;
  renderHeatmap();
}

async function refreshHealth() {
  state.health = await safeFetch('/api/health', null);
  renderHealth();
}

const QUOTES_LS_KEY = 'mp.quotes';
const QUOTES_LS_TTL_MS = 24 * 3600_000;

function restoreQuotes() {
  try {
    const raw = localStorage.getItem(QUOTES_LS_KEY);
    if (!raw) return;
    const cached = JSON.parse(raw);
    if (!cached || typeof cached !== 'object') return;
    const now = Date.now();
    for (const sym of Object.keys(cached)) {
      const q = cached[sym];
      if (!q || typeof q.price !== 'number' || (q.savedAt && now - q.savedAt > QUOTES_LS_TTL_MS)) continue;
      // Mark restored entries as stale until refresh confirms they're current.
      state.quotes[sym] = { price: q.price, dir: q.dir || '', stale: true, type: q.type };
    }
  } catch { /* ignore — localStorage can be disabled */ }
}

function persistQuotes() {
  try {
    const snap = {};
    const now = Date.now();
    for (const sym of Object.keys(state.quotes)) {
      const q = state.quotes[sym];
      if (q) snap[sym] = { price: q.price, dir: q.dir, type: q.type, savedAt: now };
    }
    localStorage.setItem(QUOTES_LS_KEY, JSON.stringify(snap));
  } catch { /* ignore */ }
}

async function refreshQuotes() {
  await Promise.all(TICKER_SYMBOLS.map(async sym => {
    const q = await safeFetch(`${API}/quote/${sym}`, null);
    if (q && typeof q.price === 'number') {
      const prev = state.quotes[sym];
      const dir = prev && q.price > prev.price ? 'up'
                : prev && q.price < prev.price ? 'down'
                : (prev?.dir || '');
      state.quotes[sym] = { price: q.price, dir, stale: false, type: q.type };
    } else if (state.quotes[sym]) {
      state.quotes[sym].stale = true;
    }
  }));
  persistQuotes();
  renderTicker();
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function fmtNotional(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

function fmtPrice(p) {
  if (typeof p !== 'number' || !Number.isFinite(p)) return '—';
  if (p >= 1000) return p.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (p >= 10)   return p.toFixed(2);
  if (p >= 1)    return p.toFixed(3);
  return p.toFixed(4);
}

function timeAgo(ts) {
  const t = typeof ts === 'string' ? new Date(ts).getTime() : Number(ts);
  const diff = (Date.now() - t) / 1000;
  if (!Number.isFinite(diff) || diff < 0) return 'now';
  if (diff < 60)    return `${Math.floor(diff)}s ago`;
  if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function escapeHtml(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function getSentiment(item) {
  const s = item?.sentiment;
  if (typeof s === 'string') {
    const u = s.toUpperCase();
    if (u === 'BULLISH' || u === 'BEARISH' || u === 'NEUTRAL') return u;
  }
  if (typeof s === 'number') {
    if (s >=  0.15) return 'BULLISH';
    if (s <= -0.15) return 'BEARISH';
    return 'NEUTRAL';
  }
  return 'NEUTRAL';
}

function getTopics(item) {
  const raw = Array.isArray(item?.topics) ? item.topics : [];
  const out = [];
  for (const entry of raw) {
    // Backend shape: [{ topic: "CRYPTO" }, ...]; tolerate plain strings too.
    const code = typeof entry === 'string' ? entry : entry?.topic;
    if (!code) continue;
    const mapped = TOPIC_REMAP[String(code).toUpperCase()] || String(code).toUpperCase();
    if (!out.includes(mapped)) out.push(mapped);
  }
  return out;
}

function getTickers(item) {
  return Array.isArray(item?.assets) ? item.assets : [];
}

function newsTimestamp(item) {
  const t = item?.time_published || item?.publishedAt || item?.ts;
  if (!t) return Date.now();
  const ms = new Date(t).getTime();
  return Number.isFinite(ms) ? ms : Date.now();
}

function newsId(item) {
  return item?.id || item?.url || `${item?.title || ''}-${newsTimestamp(item)}`;
}

function newsInWindow(items, windowMs) {
  const cutoff = Date.now() - windowMs;
  return items.filter(it => newsTimestamp(it) >= cutoff);
}

// ─── Sentiment client-side aggregation (ramp-up) ────────────────────────────

function recordSentimentBucket() {
  const now = Date.now();
  const minute = Math.floor(now / 60_000);
  const last = state.sentimentBuffer[state.sentimentBuffer.length - 1];
  const win1h = newsInWindow(state.news, 60 * 60_000);
  const counts = { BULLISH: 0, BEARISH: 0, NEUTRAL: 0 };
  for (const n of win1h) counts[getSentiment(n)]++;

  if (last && last.minute === minute) {
    Object.assign(last, counts);
  } else {
    state.sentimentBuffer.push({ minute, ts: now, ...counts });
  }
  const maxLen = 24 * 60;
  if (state.sentimentBuffer.length > maxLen) {
    state.sentimentBuffer.splice(0, state.sentimentBuffer.length - maxLen);
  }
  renderSentimentChart();
}

function getSentimentSeries() {
  const winMs = state.sentimentWindow === '24h' ? 24 * 3600_000
              : state.sentimentWindow === '4h'  ?  4 * 3600_000
              :                                        3600_000;
  const cutoff = Date.now() - winMs;
  return state.sentimentBuffer.filter(b => b.ts >= cutoff);
}

// ─── Renderers ──────────────────────────────────────────────────────────────

function renderTicker() {
  const track = document.getElementById('ticker-track');
  if (!track) return;
  const items = TICKER_SYMBOLS.map(sym => {
    const q = state.quotes[sym];
    const price = q ? fmtPrice(q.price) : '—';
    const dir = q?.dir || '';
    const stale = q?.stale ? ' data-stale="true"' : '';
    const arrow = dir === 'up' ? '▲' : dir === 'down' ? '▼' : '•';
    return `<span class="ticker-item"${stale}>` +
      `<span class="ticker-sym">${escapeHtml(sym)}</span>` +
      `<span class="ticker-price">${price}</span>` +
      `<span class="ticker-delta" data-dir="${dir}">${arrow}</span>` +
      `</span>`;
  });
  track.innerHTML = items.join('') + items.join('');
}

function renderKpis() {
  const win1h = newsInWindow(state.news, 3600_000);
  const elNews = document.getElementById('kpi-news');
  if (elNews) elNews.textContent = String(win1h.length);

  const notional = state.liqStats?.notional24h ?? null;
  const elNotional = document.getElementById('kpi-notional');
  if (elNotional) elNotional.textContent = notional != null ? fmtNotional(notional) : '—';

  const counts = { BULLISH: 0, BEARISH: 0, NEUTRAL: 0 };
  for (const n of win1h) counts[getSentiment(n)]++;
  const total = counts.BULLISH + counts.BEARISH + counts.NEUTRAL || 1;
  let dom = 'NEUTRAL';
  if (counts.BULLISH > counts.BEARISH && counts.BULLISH > counts.NEUTRAL) dom = 'BULLISH';
  else if (counts.BEARISH > counts.BULLISH && counts.BEARISH > counts.NEUTRAL) dom = 'BEARISH';

  const lbl = document.getElementById('kpi-sent-label');
  if (lbl) {
    lbl.textContent = win1h.length > 0
      ? (dom === 'BULLISH' ? 'Bullish' : dom === 'BEARISH' ? 'Bearish' : 'Neutral')
      : '—';
    lbl.classList.toggle('bull', dom === 'BULLISH' && win1h.length > 0);
    lbl.classList.toggle('bear', dom === 'BEARISH' && win1h.length > 0);
  }

  const gauge = document.getElementById('kpi-sent-gauge');
  if (gauge) {
    if (win1h.length === 0) {
      gauge.innerHTML = '';
    } else {
      const pBull = (counts.BULLISH / total) * 100;
      const pBear = (counts.BEARISH / total) * 100;
      const pNeut = 100 - pBull - pBear;
      gauge.innerHTML =
        `<span class="g-bull" style="width:${pBull.toFixed(1)}%"></span>` +
        `<span class="g-bear" style="width:${pBear.toFixed(1)}%"></span>` +
        `<span class="g-neut" style="width:${pNeut.toFixed(1)}%"></span>`;
    }
  }
}

function renderHealth() {
  const dot = document.getElementById('health-dot');
  const lbl = document.getElementById('health-label');
  const list = document.getElementById('health-list');
  if (!dot || !lbl || !list) return;

  if (!state.health) {
    dot.dataset.status = 'down';
    lbl.textContent = 'unknown';
    list.innerHTML = '';
    return;
  }

  const modules = state.health.modules || {};
  const failed = state.health.failed || [];
  const stale = Object.entries(modules).filter(([, v]) => v?.stale);

  let status = 'ok';
  if (failed.length) status = 'down';
  else if (stale.length) status = 'degraded';
  dot.dataset.status = status;
  lbl.textContent =
    status === 'ok'   ? 'All systems'
  : status === 'down' ? `${failed.length} down`
  :                     `${stale.length} stale`;

  list.innerHTML = Object.entries(modules).map(([key, val]) => {
    const ms = val?.stale ? 'degraded' : (val?.enabled === false ? 'down' : 'ok');
    return `<div class="health-mod" data-status="${ms}">${escapeHtml(key)}</div>`;
  }).join('');
}

function renderSidebar() {
  const el = document.getElementById('filters-list');
  if (!el) return;

  const counts = {};
  const win1h = newsInWindow(state.news, 3600_000);
  for (const n of win1h) {
    for (const t of getTopics(n)) counts[t] = (counts[t] || 0) + 1;
  }
  counts.ALL = win1h.length;

  el.innerHTML = TOPIC_GROUPS.map(g => `
    <div class="filter-group">
      <div class="filter-group-label">${escapeHtml(g.label)}</div>
      ${g.tabs.map(t => `
        <div class="filter-tab" data-val="${t.val}" aria-selected="${state.filter === t.val}">
          <span>${escapeHtml(t.label)}</span>
          <span class="filter-count">${counts[t.val] || 0}</span>
        </div>
      `).join('')}
    </div>
  `).join('');

  el.querySelectorAll('.filter-tab').forEach(node => {
    node.addEventListener('click', () => {
      state.filter = node.dataset.val;
      renderSidebar();
      renderSpotlight();
      renderFeed();
    });
  });
}

function filterNews(items) {
  let result = items.slice();
  if (state.filter !== 'ALL') {
    result = result.filter(n => getTopics(n).includes(state.filter));
  }
  if (state.search.trim()) {
    const q = state.search.toLowerCase();
    result = result.filter(n =>
      (n.title || '').toLowerCase().includes(q) ||
      (n.summary || '').toLowerCase().includes(q)
    );
  }
  return result;
}

function rankByImpact(a, b) {
  const score = it => {
    let s = 0;
    if (getSentiment(it) !== 'NEUTRAL') s += 2;
    s += getTickers(it).length * 0.5;
    const ageMin = (Date.now() - newsTimestamp(it)) / 60_000;
    s += Math.max(0, 60 - ageMin) / 60;
    return s;
  };
  return score(b) - score(a);
}

function spotlightTicker(filteredWindow) {
  const counts = {};
  for (const n of filteredWindow) for (const t of getTickers(n)) counts[t] = (counts[t] || 0) + 1;
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const [top, n] = sorted[0] || [null, 0];
  if (!top || n < 3) return null;
  return { ticker: top, mentions: n };
}

function renderSpotlight() {
  const wrap = document.getElementById('spotlight-wrap');
  if (!wrap) return;

  const win1h = newsInWindow(state.news, 3600_000);
  const filtered = filterNews(win1h);
  const sp = spotlightTicker(filtered);
  if (!sp) { wrap.innerHTML = ''; return; }

  const matches = filtered.filter(n => getTickers(n).includes(sp.ticker));
  const counts = { BULLISH: 0, BEARISH: 0, NEUTRAL: 0 };
  for (const n of matches) counts[getSentiment(n)]++;
  const dom = counts.BULLISH > counts.BEARISH ? 'BULLISH'
           : counts.BEARISH > counts.BULLISH ? 'BEARISH' : 'NEUTRAL';

  const sample = matches
    .sort((a, b) => newsTimestamp(b) - newsTimestamp(a))
    .slice(0, 3);

  wrap.innerHTML = `
    <div class="spotlight" data-sentiment="${dom}">
      <div class="spotlight-head">
        <span class="spotlight-tag">Symbol Spotlight</span>
        <span class="spotlight-symbol">${escapeHtml(sp.ticker)}</span>
        <span class="spotlight-meta">
          <b>${sp.mentions}</b> mentions · 60min · sentiment <b>${dom.toLowerCase()}</b>
        </span>
      </div>
      <div class="spotlight-body">
        <div class="spotlight-news">
          ${sample.map(n => `
            <div class="spotlight-row">
              <span class="sent" data-sentiment="${getSentiment(n)}">${getSentiment(n)[0]}</span>
              <span class="title">${escapeHtml((n.title || '').slice(0, 140))}</span>
              <span class="time">${timeAgo(newsTimestamp(n))}</span>
            </div>
          `).join('')}
        </div>
      </div>
    </div>
  `;
}

function newsCardEditorial(item) {
  const sent = getSentiment(item);
  const topics = getTopics(item);
  const tickers = getTickers(item);
  const id = newsId(item);
  const seen = state.seen.has(id) ? 'true' : 'false';
  const arrow = sent === 'BULLISH' ? '↑' : sent === 'BEARISH' ? '↓' : '→';
  return `
    <article class="card-editorial" data-sentiment="${sent}" data-seen="${seen}" data-id="${escapeHtml(id)}">
      <div class="meta-row">
        <span class="source">${escapeHtml(item.source || 'unknown')}</span>
        <span class="dot-sep"></span>
        <span>${timeAgo(newsTimestamp(item))}</span>
        <span class="dot-sep"></span>
        <span class="sent-chip" data-sentiment="${sent}">
          <span>${sent}</span><span class="arrow">${arrow}</span>
        </span>
      </div>
      <h2 class="card-title">${item.url
        ? `<a href="${escapeHtml(item.url)}" target="_blank" rel="noopener">${escapeHtml(item.title || '')}</a>`
        : escapeHtml(item.title || '')}</h2>
      ${item.summary ? `<p class="card-dek">${escapeHtml(item.summary)}</p>` : ''}
      ${(topics.length || tickers.length) ? `
        <div class="chip-row">
          ${topics.slice(0, 4).map(t => `<span class="topic-chip" data-topic="${t}">${escapeHtml(t)}</span>`).join('')}
          ${(topics.length && tickers.length) ? '<span class="chip-divider"></span>' : ''}
          ${tickers.slice(0, 5).map(t => `<span class="ticker-chip">${escapeHtml(t)}</span>`).join('')}
        </div>
      ` : ''}
    </article>
  `;
}

function newsCardStandard(item) {
  const sent = getSentiment(item);
  const id = newsId(item);
  const seen = state.seen.has(id) ? 'true' : 'false';
  const sentChar = sent === 'BULLISH' ? '↑' : sent === 'BEARISH' ? '↓' : '·';
  return `
    <article class="card-standard" data-sentiment="${sent}" data-seen="${seen}" data-id="${escapeHtml(id)}">
      <span class="std-sent" data-sentiment="${sent}">${sentChar}</span>
      <div class="std-body">
        <div class="std-title">${item.url
          ? `<a href="${escapeHtml(item.url)}" target="_blank" rel="noopener">${escapeHtml(item.title || '')}</a>`
          : escapeHtml(item.title || '')}</div>
        <div class="std-sub">
          <span>${escapeHtml(item.source || 'unknown')}</span>
          <span> · ${timeAgo(newsTimestamp(item))}</span>
        </div>
      </div>
      <div class="std-aside"></div>
    </article>
  `;
}

function renderFeed() {
  const list = document.getElementById('feed-list');
  if (!list) return;

  const filtered = filterNews(state.news).sort(rankByImpact);

  // Exclude items shown in the spotlight to avoid duplicates.
  const win1h = newsInWindow(state.news, 3600_000);
  const sp = spotlightTicker(filterNews(win1h));
  const spotlightIds = new Set();
  if (sp) {
    win1h.filter(n => getTickers(n).includes(sp.ticker))
         .sort((a, b) => newsTimestamp(b) - newsTimestamp(a))
         .slice(0, 3)
         .forEach(n => spotlightIds.add(newsId(n)));
  }
  const final = filtered.filter(n => !spotlightIds.has(newsId(n)));

  if (final.length === 0) {
    list.innerHTML = `<div style="padding:40px;text-align:center;color:var(--text-tertiary)">No news matching filter.</div>`;
    return;
  }

  const editorial = final.slice(0, 3).map(newsCardEditorial).join('');
  const standard = final.slice(3, 50).map(newsCardStandard).join('');
  list.innerHTML = editorial + standard;

  list.querySelectorAll('article[data-id]').forEach(el => {
    el.addEventListener('click', () => {
      state.seen.add(el.dataset.id);
      el.dataset.seen = 'true';
    });
  });
}

function renderSentimentChart() {
  const svg = document.getElementById('sent-svg');
  const xaxis = document.getElementById('sent-xaxis');
  if (!svg) return;

  const series = getSentimentSeries();
  if (series.length < 2) {
    svg.innerHTML = `<text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle"
                       fill="var(--text-tertiary)" font-size="11">warming up — collecting data…</text>`;
    if (xaxis) xaxis.innerHTML = '';
    return;
  }

  const W = 300, H = 100;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

  const winMs = state.sentimentWindow === '24h' ? 24 * 3600_000
              : state.sentimentWindow === '4h'  ?  4 * 3600_000
              :                                        3600_000;
  const now = Date.now();

  const max = Math.max(...series.map(b => b.BULLISH + b.BEARISH + b.NEUTRAL), 1);

  // Map x by absolute age within window: now → right edge, cutoff → left edge.
  // Older windows (4h/24h) keep recent points clustered to the right, exposing
  // the ramp-up gap where no data has been collected yet.
  const pts = series.map(b => {
    const age = Math.max(0, now - b.ts);
    const x = W - (age / winMs) * W;
    const totalAtPt = b.BULLISH + b.BEARISH + b.NEUTRAL;
    const yBull = (1 - b.BULLISH / max) * H;
    const yNeut = (1 - (b.BULLISH + b.NEUTRAL) / max) * H;
    const yBear = (1 - totalAtPt / max) * H;
    return { x, yBull, yNeut, yBear };
  });

  const polyArea = (yKey, baselineKey) => {
    const top = pts.map(p => `${p.x.toFixed(2)},${p[yKey].toFixed(2)}`).join(' ');
    const bottom = baselineKey
      ? [...pts].reverse().map(p => `${p.x.toFixed(2)},${p[baselineKey].toFixed(2)}`).join(' ')
      : `${W},${H} 0,${H}`;
    return `${top} ${bottom}`;
  };

  svg.innerHTML =
    `<polygon points="${polyArea('yBear', null)}" fill="var(--bear-fg)" opacity="0.15" />` +
    `<polygon points="${polyArea('yNeut', 'yBear')}" fill="var(--neutral-fg)" opacity="0.12" />` +
    `<polygon points="${polyArea('yBull', 'yNeut')}" fill="var(--bull-fg)" opacity="0.18" />` +
    `<polyline points="${pts.map(p => `${p.x.toFixed(2)},${p.yBear.toFixed(2)}`).join(' ')}" fill="none" stroke="var(--bear-fg)" stroke-width="1.2" />` +
    `<polyline points="${pts.map(p => `${p.x.toFixed(2)},${p.yBull.toFixed(2)}`).join(' ')}" fill="none" stroke="var(--bull-fg)" stroke-width="1.2" />`;

  if (xaxis) {
    const win = state.sentimentWindow;
    const labels = win === '24h' ? ['-24h', '-18h', '-12h', '-6h', 'now']
                : win === '4h'  ? ['-4h',  '-3h',  '-2h',  '-1h', 'now']
                :                  ['-60m', '-45m', '-30m', '-15m', 'now'];
    xaxis.innerHTML = labels.map(l => `<span>${l}</span>`).join('');
  }
}

function renderLiqs() {
  const el = document.getElementById('liq-feed');
  if (!el) return;

  const filtered = state.liqs.filter(l => (l.notional ?? 0) >= state.minLiq);
  const recent = filtered.slice(0, 6);

  if (recent.length === 0) {
    el.innerHTML = `<div style="padding:16px;text-align:center;color:var(--text-tertiary);font-size:11px">No liquidations above threshold.</div>`;
    return;
  }

  el.innerHTML = recent.map(l => {
    const side = (l.side || '').toUpperCase();
    const fundingPct = typeof l.funding === 'number'
      ? (Math.abs(l.funding) >= 0.0001 ? (l.funding * 100).toFixed(3) + '%' : null)
      : null;
    const sign = (l.funding || 0) > 0 ? 'pos' : (l.funding || 0) < 0 ? 'neg' : '';
    return `
      <div class="liq-item" data-side="${side}">
        <div class="liq-head">
          <span class="side" data-side="${side}">${side}</span>
          <span class="liq-exch">${escapeHtml(l.exchange || '')}</span>
        </div>
        <div class="liq-notional">${fmtNotional(l.notional)}</div>
        <div class="liq-detail">
          <span>${escapeHtml(l.symbol || '')}</span>
          <span>· ${timeAgo(l.ts || l.timestamp || Date.now())}</span>
          ${fundingPct ? `<span class="funding" data-sign="${sign}">funding ${fundingPct}</span>` : ''}
        </div>
      </div>
    `;
  }).join('');
}

function renderHeatmap() {
  const el = document.getElementById('heatmap');
  if (!el) return;

  const list = state.derivs?.list || [];
  if (list.length === 0) {
    el.innerHTML = `<div style="padding:12px;text-align:center;color:var(--text-tertiary);font-size:11px;grid-column:1/-1">No derivatives data.</div>`;
    return;
  }

  const top = list
    .filter(d => typeof d.fundingRatePct === 'number')
    .sort((a, b) => Math.abs(b.fundingRatePct) - Math.abs(a.fundingRatePct))
    .slice(0, 6);

  const maxAbs = Math.max(...top.map(d => Math.abs(d.fundingRatePct)), 0.01);

  el.innerHTML = top.map(d => {
    const rate = d.fundingRatePct;
    const sign = rate >= 0 ? 'pos' : 'neg';
    const ratio = Math.abs(rate) / maxAbs;
    const intensity = ratio > 0.66 ? 'hi' : ratio > 0.33 ? 'med' : 'lo';
    const ratePct = (rate * 100).toFixed(3) + '%';
    const oi = d.openInterestValueUsd ?? d.openInterestUsd;
    return `
      <div class="heat-cell" data-sign="${sign}" data-intensity="${intensity}">
        <span class="heat-sym">${escapeHtml(d.symbol || '')}</span>
        <span class="heat-rate">${ratePct}</span>
        <span class="heat-oi">${oi != null ? fmtNotional(oi) : '—'}</span>
      </div>
    `;
  }).join('');
}

// ─── Bindings ───────────────────────────────────────────────────────────────

function bindControls() {
  const search = document.getElementById('search');
  if (search) {
    search.addEventListener('input', () => {
      state.search = search.value;
      renderSpotlight();
      renderFeed();
    });
    document.addEventListener('keydown', e => {
      if (e.key === '/' && document.activeElement !== search) {
        e.preventDefault();
        search.focus();
      }
    });
  }

  const minLiq = document.getElementById('min-liq');
  const minLiqVal = document.getElementById('min-liq-val');
  if (minLiq && minLiqVal) {
    minLiq.addEventListener('input', () => {
      const k = parseInt(minLiq.value, 10) || 0;
      state.minLiq = k * 1000;
      minLiqVal.textContent = k >= 1000 ? `$${(k / 1000).toFixed(1)}M` : `$${k}K`;
      renderLiqs();
    });
  }

  document.querySelectorAll('.ops-tabs[data-grp="sent-window"] button').forEach(btn => {
    btn.addEventListener('click', () => {
      const grp = btn.parentElement;
      grp.querySelectorAll('button').forEach(b => b.setAttribute('aria-selected', 'false'));
      btn.setAttribute('aria-selected', 'true');
      state.sentimentWindow = btn.dataset.val;
      renderSentimentChart();
    });
  });
}

// ─── Boot ───────────────────────────────────────────────────────────────────

(async function boot() {
  bindControls();

  // Hydrate from localStorage so variations are visible from the first render
  // (otherwise the initial fetch has no `prev` price → all deltas neutral).
  restoreQuotes();
  renderTicker();

  await Promise.all([
    refreshNews(),
    refreshLiquidations(),
    refreshLiqStats(),
    refreshDerivatives(),
    refreshHealth(),
    refreshQuotes(),
  ]);

  setInterval(refreshNews,           INTERVALS.news);
  setInterval(refreshLiquidations,   INTERVALS.liquidations);
  setInterval(refreshLiqStats,       INTERVALS.liqStats);
  setInterval(refreshDerivatives,    INTERVALS.derivatives);
  setInterval(refreshHealth,         INTERVALS.health);
  setInterval(refreshQuotes,         INTERVALS.quotes);
  setInterval(recordSentimentBucket, INTERVALS.sentimentBucket);
})();
