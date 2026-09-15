// Shared helpers for pipeline jobs. No secrets logged. All externals env-gated.
import { Pool } from 'pg';

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  connectionTimeoutMillis: 5000,
});

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export async function fetchText(url, { timeoutMs = 25000, headers = {} } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'BeriklanPipeline/1.0', ...headers }, signal: ctl.signal });
    const text = await r.text();
    return { status: r.status, text };
  } finally { clearTimeout(t); }
}

// Minimal sitemap <loc>+<lastmod> parser (machine-generated XML — regex is fine).
export function parseSitemapUrls(xml) {
  const out = [];
  const re = /<url>[\s\S]*?<loc>\s*([^<]+?)\s*<\/loc>(?:[\s\S]*?<lastmod>\s*([^<]+?)\s*<\/lastmod>)?[\s\S]*?<\/url>/gi;
  let m;
  while ((m = re.exec(xml || '')) && out.length < 5000) {
    out.push({ loc: m[1].trim(), lastmod: (m[2] || '').trim() });
  }
  // also support <sitemap> index entries
  const re2 = /<sitemap>[\s\S]*?<loc>\s*([^<]+?)\s*<\/loc>(?:[\s\S]*?<lastmod>\s*([^<]+?)\s*<\/lastmod>)?[\s\S]*?<\/sitemap>/gi;
  while ((m = re2.exec(xml || '')) && out.length < 6000) {
    out.push({ loc: m[1].trim(), lastmod: (m[2] || '').trim(), isIndex: true });
  }
  return out;
}

export async function jobStart(job) {
  try {
    const { rows } = await pool.query(
      `INSERT INTO shared.job_runs (job, status) VALUES ($1,'running') RETURNING id`, [job]);
    return rows[0]?.id || null;
  } catch { return null; }
}
export async function jobEnd(id, status, detail = '') {
  if (!id) return;
  try {
    await pool.query(`UPDATE shared.job_runs SET status=$2, detail=$3, ended_at=now() WHERE id=$1`,
      [id, status, String(detail).slice(0, 2000)]);
  } catch {}
}

export async function telegram(text) {
  const tok = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHANNEL_ID;
  if (!tok || !chat) { console.log('[telegram] skipped (no env)'); return false; }
  try {
    const r = await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: String(text).slice(0, 3500) }),
    });
    return r.ok;
  } catch (e) { console.log('[telegram] error:', String(e).slice(0, 100)); return false; }
}

// IndexNow submit (Bing + api.indexnow.org + Yandex). Key file must be hosted on the domain.
export async function indexNowSubmit(host, key, urls) {
  const results = [];
  const body = JSON.stringify({ host, key, keyLocation: `https://${host}/${key}.txt`, urlList: urls.slice(0, 100) });
  for (const ep of ['https://www.bing.com/indexnow', 'https://api.indexnow.org/indexnow', 'https://yandex.com/indexnow']) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 20000);
      const r = await fetch(ep, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8', 'User-Agent': 'BeriklanPipeline/1.0' }, body, signal: ctl.signal });
      clearTimeout(t);
      results.push({ ep, status: r.status });
    } catch (e) { results.push({ ep, error: String(e).slice(0, 80) }); }
  }
  return results;
}

// Positive/negative word heuristic (ID+EN) — v0 sentiment, documented as heuristic.
const POS = ['bagus','terbaik','recommended','recommended','bagus','terpercaya','profesional','puas','efektif','helpful','excellent','great','trusted','best','positif','memuaskan','cepat','ramah'];
const NEG = ['buruk','kecewa','scam','penipu','jelek','mahal','lambat','bad','terrible','awful','scam','disappointing','buruk','komplain','complaint','rugi'];
export function sentimentHeuristic(text) {
  const t = (text || '').toLowerCase();
  let p = 0, n = 0;
  for (const w of POS) if (t.includes(w)) p++;
  for (const w of NEG) if (t.includes(w)) n++;
  if (p > n) return 'positive';
  if (n > p) return 'negative';
  return 'neutral';
}
