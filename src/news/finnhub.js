import { deriveTopics, extractAssets } from './topics.js';
import { safeErr } from '../utils/safeErr.js';

// Finnhub /news returns no sentiment field — derive a coarse signal from the
// headline. Conservative: only score when one polarity is present without the
// other. Magnitude is fixed (1.0) since we have no confidence signal.
const POSITIVE_WORDS = /\b(surge|jump|rally|gain|beat|record|soar|ris(e|es|ing)|bullish|optimis(m|tic)|upgrade|outperform|breakthrough)\b/i;
const NEGATIVE_WORDS = /\b(plunge|drop|crash|miss(es|ed)?|bearish|loss(es)?|fall(s|ing)?|slump|fear|warn|downgrade|cut|lawsuit|probe|fraud)\b/i;

function classifyHeadlineScore(headline) {
  const t = headline || '';
  const pos = POSITIVE_WORDS.test(t);
  const neg = NEGATIVE_WORDS.test(t);
  if (pos && !neg) return 1;
  if (neg && !pos) return -1;
  return 0;
}

const scoreToLabel = s => (s > 0.15 ? 'BULLISH' : s < -0.15 ? 'BEARISH' : 'NEUTRAL');

const safeHostname = (url) => { try { return new URL(url).hostname; } catch { return ''; } };

async function fetchCategory(apiKey, category, signal, log) {
  const url = `https://finnhub.io/api/v1/news?category=${encodeURIComponent(category)}&token=${apiKey}`;
  const res = await fetch(url, { signal });
  if (!res.ok) {
    log?.warn({ category, status: res.status }, 'finnhub fetch failed');
    return [];
  }
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

export async function fetchFinnhubNews({ apiKey, categories, log, timeoutMs = 15_000 }) {
  if (!apiKey) {
    log?.warn('finnhub disabled: FINNHUB_KEY missing');
    return [];
  }
  const fetchedAt = new Date().toISOString();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort('timeout'), timeoutMs);

  try {
    const results = await Promise.allSettled(
      categories.map(c => fetchCategory(apiKey, c, ac.signal, log))
    );

    const out = [];
    results.forEach((r, i) => {
      if (r.status !== 'fulfilled') {
        log?.warn({ category: categories[i], err: safeErr(r.reason) }, 'finnhub category errored');
        return;
      }
      const cat = categories[i];
      for (const it of r.value) {
        if (!it?.url || !it?.headline) continue;
        const score = classifyHeadlineScore(it.headline);
        out.push({
          title: it.headline,
          summary: it.summary || '',
          url: it.url,
          source: it.source || '',
          source_domain: safeHostname(it.url),
          time_published: new Date((it.datetime || 0) * 1000).toISOString(),
          topics: deriveTopics({
            source_api: 'finnhub',
            finnhubCategory: cat,
            title: it.headline,
          }).map(topic => ({ topic })),
          assets: extractAssets({ related: it.related, title: it.headline }),
          sentiment: scoreToLabel(score),
          sentiment_score: score,
          banner_image: it.image || undefined,
          source_api: 'finnhub',
          fetchedAt,
        });
      }
    });
    return out;
  } finally {
    clearTimeout(timer);
  }
}
