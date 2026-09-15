// C2. distribute (tiap 6 jam): IndexNow URL terbaru + webhook/IFTTT + Telegram.
// Channel opsional di-skip bila env kosong (tercatat di log, bukan error).
import { fetchText, parseSitemapUrls, indexNowSubmit, jobStart, jobEnd, telegram } from './lib.js';

const DOMAINS = [
  { domain: 'coid', host: 'beriklan.co.id', key: process.env.INDEXNOW_KEY_COID || '' },
  { domain: 'comy', host: 'beriklan.my', key: process.env.INDEXNOW_KEY_COMY || '' },
];

export async function runDistribute({ maxUrls = 30 } = {}) {
  const id = await jobStart('distribute');
  const log = [];
  try {
    const allFresh = [];
    for (const d of DOMAINS) {
      try {
        const { status, text } = await fetchText(`https://${d.host}/news.xml`);
        if (status !== 200) { log.push(`${d.host} news.xml http=${status}`); continue; }
        const urls = parseSitemapUrls(text)
          .map(u => u.loc)
          .filter(u => u.startsWith('http') && !u.endsWith('.xml'))
          .slice(0, maxUrls);
        log.push(`${d.host}: ${urls.length} fresh urls`);
        if (urls.length && d.key) {
          const res = await indexNowSubmit(d.host, d.key, urls);
          log.push(`${d.host} indexnow: ${JSON.stringify(res)}`);
        }
        urls.slice(0, 10).forEach(u => allFresh.push({ host: d.host, url: u }));
      } catch (e) { log.push(`${d.host} error: ${String(e).slice(0, 80)}`); }
    }
    // Webhook / IFTTT (opsional)
    const hook = process.env.DISTRIBUTE_WEBHOOK;
    if (hook && allFresh.length) {
      try {
        const r = await fetch(hook, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ source: 'seo-pipeline', count: allFresh.length, urls: allFresh.slice(0, 10) }) });
        log.push(`webhook: http=${r.status}`);
      } catch (e) { log.push(`webhook error: ${String(e).slice(0, 60)}`); }
    } else log.push('webhook skipped (no env or no urls)');
    // Telegram ringkasan (opsional)
    if (allFresh.length) {
      const sent = await telegram(`[Beriklan distribute] ${allFresh.length} URL fresh didistribusikan:\n` +
        allFresh.slice(0, 8).map(f => `• ${f.url}`).join('\n'));
      log.push(`telegram: ${sent ? 'sent' : 'skipped'}`);
    }
    await jobEnd(id, 'ok', log.join(' | '));
    return { ok: true, log, count: allFresh.length };
  } catch (e) {
    await jobEnd(id, 'failed', String(e).slice(0, 300));
    return { ok: false, error: String(e).slice(0, 200), log };
  }
}
