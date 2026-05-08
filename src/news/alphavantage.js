import { deriveTopics, extractAssets } from './topics.js';
import { safeErr } from '../utils/safeErr.js';

// Alpha Vantage rejects "Invalid inputs" when too many topics are passed at
// once via &topics=. We omit the filter and let the API return all news; the
// per-item `topics` field is then mapped to the unified taxonomy locally.

const LABEL_MAP = {
  'Bullish':           'BULLISH',
  'Somewhat-Bullish':  'BULLISH',
  'Bearish':           'BEARISH',
  'Somewhat-Bearish':  'BEARISH',
  'Neutral':           'NEUTRAL',
};

// Alpha Vantage uses "20260507T120000" (UTC) — convert to ISO 8601.
function parseAvTime(s) {
  if (typeof s !== 'string' || s.length < 15) return new Date(0).toISOString();
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`;
}

// Returns `{ items, rateLimited }`. The two states must be distinguishable
// by callers because rate-limited means "the cache should be preserved",
// whereas an empty `items` after a normal call genuinely means "no news".
export async function fetchAlphaVantageNews({ apiKey, log, timeoutMs = 20_000 }) {
  if (!apiKey) {
    log?.warn('alphavantage disabled: ALPHAVANTAGE_KEY missing');
    return { items: [], rateLimited: false };
  }
  const url =
    `https://www.alphavantage.co/query?function=NEWS_SENTIMENT` +
    `&sort=LATEST&limit=200&apikey=${apiKey}`;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort('timeout'), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) {
      log?.warn({ status: res.status }, 'alphavantage fetch failed');
      return { items: [], rateLimited: false };
    }
    const json = await res.json();

    // Alpha Vantage returns 200 with "Information" / "Note" payloads when the
    // free-tier daily quota is exhausted or rate-limited. Sometimes (quota
    // edge), the same response also carries a non-empty `feed`; in that case
    // we still process it — losing valid items on a soft rate-limit would be
    // a worse outcome than serving them.
    const notice = json?.Information || json?.Note;
    const hasFeed = Array.isArray(json?.feed) && json.feed.length > 0;
    if (notice && !hasFeed) {
      log?.warn({ message: notice }, 'alphavantage rate-limited');
      return { items: [], rateLimited: true };
    }
    if (!Array.isArray(json?.feed)) {
      log?.warn({ keys: Object.keys(json || {}) }, 'alphavantage: missing feed');
      return { items: [], rateLimited: false };
    }
    if (notice) {
      log?.warn({ message: notice, feed: json.feed.length }, 'alphavantage rate-limit notice with feed — processing anyway');
    }

    const fetchedAt = new Date().toISOString();
    const items = json.feed
      .filter(it => it?.url && it?.title)
      .map(it => ({
        title: it.title,
        summary: it.summary || '',
        url: it.url,
        source: it.source || '',
        source_domain: it.source_domain || '',
        time_published: parseAvTime(it.time_published),
        topics: deriveTopics({
          source_api: 'alphavantage',
          alphaTopics: it.topics,
          title: it.title,
        }).map(topic => ({ topic })),
        assets: extractAssets({ title: it.title, tickerSentiment: it.ticker_sentiment }),
        sentiment: LABEL_MAP[it.overall_sentiment_label] || 'NEUTRAL',
        sentiment_score: parseFloat(it.overall_sentiment_score) || 0,
        banner_image: it.banner_image || undefined,
        source_api: 'alphavantage',
        fetchedAt,
      }));
    return { items, rateLimited: false };
  } catch (e) {
    log?.warn({ err: safeErr(e) }, 'alphavantage fetch errored');
    return { items: [], rateLimited: false };
  } finally {
    clearTimeout(timer);
  }
}
