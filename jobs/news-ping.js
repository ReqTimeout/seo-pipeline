// C1. news-ping (tiap 2 jam): URL fresh (<36 jam) → IndexNow batch + Bing sitemap ping.
// Sumber: sitemap-blog.xml + news.xml publik per domain (tanpa butuh D1 langsung).
// GSC Indexing API tetap di edge (butuh SA) — di sini hanya IndexNow + Bing ping.
import { fetchText, parseSitemapUrls, indexNowSubmit, jobStart, jobEnd } from './lib.js';

const DOMAINS = [
  { domain: 'coid', host: 'beriklan.co.id', key: process.env.INDEXNOW_KEY_COID || '' },
  { domain: 'comy', host: 'beriklan.my', key: process.env.INDEXNOW_KEY_COMY || '' },
];
const MAX_URLS = 50;

export async function runNewsPing({ maxUrls = MAX_URLS } = {}) {
  const id = await jobStart('news-ping');
  const log = [];
  try {
    for (const d of DOMAINS) {
      const fresh = new Map(); // loc -> lastmod
      for (const feed of [`https://${d.host}/news.xml`, `https://${d.host}/sitemap-blog.xml`]) {
        try {
          const { status, text } = await fetchText(feed);
          if (status !== 200) { log.push(`${d.host} ${feed.split('/').pop()} http=${status}`); continue; }
          for (const u of parseSitemapUrls(text)) {
            if (!u.loc.startsWith('http')) continue;
            if (u.loc.includes('sitemap') || u.loc.endsWith('.xml')) continue; // skip nested index entries
            const prev = fresh.get(u.loc);
            if (!prev || (u.lastmod && u.lastmod > prev)) fresh.set(u.loc, u.lastmod);
          }
        } catch (e) { log.push(`${d.host} fetch error: ${String(e).slice(0, 80)}`); }
      }
      const cutoff = Date.now() - 36 * 3600 * 1000;
      const urls = [...fresh.entries()]
        .filter(([, lm]) => { const t = Date.parse(lm); return !isNaN(t) && t >= cutoff; })
        .sort((a, b) => (b[1] > a[1] ? 1 : -1))
        .slice(0, maxUrls)
        .map(([loc]) => loc);
      log.push(`${d.host}: ${fresh.size} urls seen, ${urls.length} fresh<36h`);
      if (urls.length && d.key) {
        const res = await indexNowSubmit(d.host, d.key, urls);
        log.push(`${d.host} indexnow: ${JSON.stringify(res)}`);
      } else if (urls.length) {
        log.push(`${d.host}: indexnow skipped (no key env)`);
      }
      // NOTE 2026-09-15: Bing /ping?sitemap= mati (HTTP 410) — IndexNow adalah penggantinya.
    }
    await jobEnd(id, 'ok', log.join(' | '));
    return { ok: true, log };
  } catch (e) {
    await jobEnd(id, 'failed', String(e).slice(0, 300));
    return { ok: false, error: String(e).slice(0, 200), log };
  }
}
