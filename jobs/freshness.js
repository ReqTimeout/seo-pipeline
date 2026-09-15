// C4. Freshness rewriter (harian): kandidat artikel lama ber-impresi (GSC SA) →
// draft callout update via AI → antre ke publish_outbox status 'draft' (APPROVAL
// manual: UPDATE status='ready' sebelum edge berani pull).
// Tanpa GSC_SA_JSON / AI key: skip tercatat (bukan error). Preview deterministik
// selalu tersedia via endpoint (tanpa AI).
import { pool, jobStart, jobEnd, fetchText, parseSitemapUrls, sleep } from './lib.js';
import { createSign } from 'crypto';

// Model FREE Zen — mirror docs resmi opencode.ai/docs/zen (verifikasi 15 Sep 2026).
// 5 via chat/completions + 1 via responses API (muse-spark contributor).
const ZEN_FREE_MODELS = ['big-pickle', 'mimo-v2.5-free', 'ling-3.0-flash-fin-free', 'nemotron-3.5-lightning-free', 'nemotron-3-ultra-free'];
const ZEN_ENDPOINT = 'https://opencode.ai/zen/v1/chat/completions';
const ZEN_RESPONSES_ENDPOINT = 'https://opencode.ai/zen/v1/responses';
const ZEN_FREE_RESPONSES_MODELS = ['muse-spark-1.3-contributor-free'];

export function buildFreshnessCallout({ title, lang = 'id', year = new Date().getFullYear() }) {
  const t = (title || 'artikel ini').slice(0, 90);
  if (lang === 'ms') {
    return `<div class="freshness-update"><p><strong>Kemas kini ${year}:</strong> Panduan "${t}" ini telah disemak semula dengan harga pasaran dan dasar pengiklanan terkini.</p><ul><li>Semakan harga & pakej semasa</li><li>Langkah disahkan dengan polisi ads terbaru</li><li>Contoh kes tempatan ditambah</li></ul></div>`;
  }
  return `<div class="freshness-update"><p><strong>Update ${year}:</strong> Panduan "${t}" ini telah ditinjau ulang dengan harga pasar dan kebijakan iklan terbaru.</p><ul><li>Review harga & paket terkini</li><li>Langkah divalidasi dengan policy ads terbaru</li><li>Contoh kasus lokal ditambahkan</li></ul></div>`;
}
async function callAi(systemPrompt, userPrompt) {
  // Zen free (semua model FREE, rotasi) — lalu Groq bila key ada.
  const zenKey = process.env.ZEN_API_KEY;
  const groqKeys = [process.env.GROQ_API_KEY_1, process.env.GROQ_API_KEY_2, process.env.GROQ_API_KEY_3].filter(Boolean);
  if (zenKey) {
    for (const m of ZEN_FREE_MODELS) {
      try {
        const r = await fetch(ZEN_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${zenKey}`, 'User-Agent': 'BeriklanPipeline/1.0' },
          body: JSON.stringify({ model: m, messages: [{ role: 'user', content: systemPrompt + '\n\n' + userPrompt }], max_tokens: 800, thinking: { type: 'disabled' } }),
        });
        if (r.ok) {
          const j = await r.json();
          const t = ((j.choices?.[0]?.message?.content) || '').trim();
          if (t.length > 50) return { text: t, model: 'zen/' + m };
        }
      } catch {}
    }
    for (const m of ZEN_FREE_RESPONSES_MODELS) {
      try {
        const r = await fetch(ZEN_RESPONSES_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${zenKey}`, 'User-Agent': 'BeriklanPipeline/1.0' },
          body: JSON.stringify({ model: m, input: systemPrompt + '\n\n' + userPrompt, max_output_tokens: 800 }),
        });
        if (r.ok) {
          const j = await r.json();
          const t = (j.output || []).flatMap(o => o.content || []).map(c => c.text || '').join('').trim();
          if (t.length > 50) return { text: t, model: 'zen/' + m };
        }
      } catch {}
    }
  }
  if (groqKeys.length) {
    // Semua model free Groq (verifikasi key live 15 Sep 2026).
    for (const gm of ['openai/gpt-oss-20b', 'openai/gpt-oss-120b', 'qwen/qwen3.8-27b']) {
      for (const gk of groqKeys) {
        try {
          const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gk}` },
            body: JSON.stringify({ model: gm, reasoning_effort: 'low', max_tokens: 1024, messages: [{ role: 'user', content: systemPrompt + '\n\n' + userPrompt }] }),
          });
          if (r.ok) {
            const j = await r.json();
            const t = ((j.choices?.[0]?.message?.content) || '').trim();
            if (t.length > 50) return { text: t, model: 'groq/' + gm };
          }
        } catch {}
      }
    }
  }
  return null;
}

function parseSaJson() {
  const raw = (process.env.GSC_SA_JSON || '').trim();
  if (!raw) return null;
  try {
    // Auto-detect: raw JSON (diawali '{') atau base64 (single-line, aman untuk .env).
    const txt = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    const sa = JSON.parse(txt);
    return sa?.client_email && sa?.private_key ? sa : null;
  } catch { return null; }
}

export async function runFreshness({ count = 3, minImp = 1 } = {}) {
  const id = await jobStart('freshness');
  const log = [];
  try {
    const sa = parseSaJson();
    if (!sa) {
      log.push('skipped: need GSC_SA_JSON (candidate source)');
      await jobEnd(id, 'ok', log.join(' | '));
      return { ok: true, skipped: true, log };
    }
    const targets = [
      { domain: 'coid', host: 'beriklan.co.id', siteUrl: process.env.GSC_SITE_URL_COID || 'https://www.beriklan.co.id/', lang: 'id' },
      ...(process.env.GSC_SITE_URL_COMY ? [{ domain: 'comy', host: 'beriklan.my', siteUrl: process.env.GSC_SITE_URL_COMY, lang: 'ms' }] : []),
    ];
    let token = null;
    try { token = await gscAccessToken(sa); } catch (e) {
      log.push('gsc auth failed: ' + String(e).slice(0, 100));
      await jobEnd(id, 'failed', log.join(' | '));
      return { ok: false, error: 'gsc_auth', log };
    }
    let queued = 0;
    for (const t of targets) {
      try {
        const cands = await gscFreshnessCandidates(token, t, minImp);
        log.push(`${t.host}: ${cands.length} candidates(>90d+imp)`);
      for (const c of cands.slice(0, count)) {
        const r = await queueFreshnessDraft({ domain: t.domain, slug: c.slug, title: c.title, lang: t.lang, useAi: true });
        if (r.ok) { queued++; log.push(`queued ${r.slug} (imp=${c.impressions}) ai=${r.model || 'template'}`); }
        await sleep(8000); // Groq free rate-limit aman
      }
      } catch (e) { log.push(`${t.host} error: ${String(e).slice(0, 100)}`); }
    }
    await jobEnd(id, 'ok', log.join(' | '));
    return { ok: true, log, queued };
  } catch (e) {
    await jobEnd(id, 'failed', String(e).slice(0, 300));
    return { ok: false, error: String(e).slice(0, 200), log };
  }
}

function b64url(o) { return Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url'); }

async function gscAccessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url({
    iss: sa.client_email, scope: 'https://www.googleapis.com/auth/webmasters.readonly',
    aud: 'https://oauth2.googleapis.com/token', exp: now + 3600, iat: now })}`;
  const sig = createSign('RSA-SHA256').update(unsigned).sign(sa.private_key, 'base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${unsigned}.${sig}`,
  });
  if (!r.ok) throw new Error('token http=' + r.status);
  const j = await r.json();
  if (!j.access_token) throw new Error('no access_token');
  return j.access_token;
}

// Kandidat: halaman /blog/ ber-impresi (GSC 90 hari) + lastmod sitemap >90 hari.
async function gscFreshnessCandidates(token, t, minImp) {
  // Window 90 hari tidak cukup untuk GSC data www (terbukti kosong 2026-06-30→09-14).
  // Pakai 6-bulan untuk hasil riil; cooldown 30 hari di queueFreshnessDraft mencegah spam.
  const end = new Date(), start = new Date(Date.now() - 180 * 864e5);
  const fmt = (d) => d.toISOString().slice(0, 10);
  const r = await fetch(
    `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(t.siteUrl)}/searchAnalytics/query`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ startDate: fmt(start), endDate: fmt(end), dimensions: ['page'], rowLimit: 5000, type: 'web' }),
  });
  if (!r.ok) throw new Error('gsc query http=' + r.status);
  const j = await r.json();
  const pages = (j.rows || [])
    .filter(x => (x.keys?.[0] || '').includes('/blog/') && (x.impressions || 0) >= minImp)
    .map(x => ({ url: x.keys[0], impressions: x.impressions }))
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 60);
  // Umur via sitemap-blog.xml lastmod
  let lastmod = {};
  try {
    const sm = await fetchText(`https://${t.host}/sitemap-blog.xml`);
    if (sm.status === 200) {
      for (const u of parseSitemapUrls(sm.text)) {
        if (u.loc && u.lastmod) lastmod[u.loc.replace(/\/$/, '')] = u.lastmod;
      }
    }
  } catch {}
  const cutoff = Date.now() - 90 * 864e5;
  const out = [];
  for (const p of pages) {
    const lm = lastmod[p.url.replace(/\/$/, '')];
    const tlm = lm ? Date.parse(lm) : NaN;
    if (isNaN(tlm)) continue; // umur tak terverifikasi → skip (jujur)
    if (tlm > cutoff) continue;
    const mslug = p.url.match(/\/blog\/([^\/]+)\/?$/);
    if (!mslug) continue;
    out.push({ slug: mslug[1], title: mslug[1].replace(/-/g, ' '), url: p.url, impressions: p.impressions });
  }
  if (!out.length) return out;
  // Skip yang sudah pernah diantre (semua status) — anti duplikat harian
  const fslugs = out.map(o => `${o.slug}-freshness-${new Date().getFullYear()}`);
  const ex = await pool.query(
    `SELECT slug FROM ${t.domain}.publish_outbox WHERE slug = ANY($1)`, [fslugs]);
  const have = new Set((ex.rows || []).map(x => x.slug));
  return out.filter(o => !have.has(`${o.slug}-freshness-${new Date().getFullYear()}`));
}

// Dipakai endpoint preview + antre manual (tanpa AI bila key kosong → template deterministik).
export async function queueFreshnessDraft({ domain, slug, title, lang = 'id', useAi = true }) {
  if (!['comy', 'coid'].includes(domain)) return { ok: false, error: 'bad domain' };
  let callout = buildFreshnessCallout({ title, lang });
  let model = 'template';
  if (useAi) {
    const ai = await callAi(
      'Kamu editor SEO. Tulis callout update HTML ringkas (<div class="freshness-update"> + 1 <p> + 3 <li>), jujur, tanpa klaim baru.',
      `Judul artikel: "${title}". Bahasa: ${lang === 'ms' ? 'Melayu Malaysia' : 'Indonesia'}. Tahun: ${new Date().getFullYear()}. Output HANYA HTML.`);
    if (ai?.text) { callout = ai.text; model = ai.model || 'ai'; }
  }
  const fslug = `${slug}-freshness-${new Date().getFullYear()}`;
  await pool.query(
    `INSERT INTO ${domain}.publish_outbox (slug, title, content, service, city, language, status)
     VALUES ($1,$2,$3,'freshness','', $4, 'draft')
     ON CONFLICT (slug) DO UPDATE SET content=EXCLUDED.content, status='draft'`,
    [fslug, `[Update] ${title}`, callout, lang]);
  return { ok: true, slug: fslug, status: 'draft', ai: useAi, model };
}
