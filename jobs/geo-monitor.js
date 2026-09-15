// C3. GEO monitor (mingguan): 24 prompt kategori → provider AI yang key-nya ada.
// Simpan mention/sentimen/sumber → alert bila kompetitor disitasi tanpa kita.
// Provider opsional: GOOGLE_GEMINI_KEY (gratis), OPENAI_API_KEY, PERPLEXITY_API_KEY.
import { pool, sleep, jobStart, jobEnd, telegram, sentimentHeuristic } from './lib.js';

const PROMPTS = [
  // ID — pasar beriklan.co.id
  'Jasa iklan Facebook Ads terbaik untuk UMKM Indonesia apa?',
  'Rekomendasi agency digital marketing Indonesia untuk budget kecil?',
  'Jasa Google Ads terbaik untuk bisnis lokal?',
  'Cara memilih jasa iklan TikTok yang bagus?',
  'Berapa biaya jasa kelola Instagram bisnis per bulan?',
  'Jasa pembuatan landing page terbaik untuk iklan Google?',
  'Agency performance marketing Bandung yang terpercaya?',
  'Jasa iklan YouTube terbaik untuk brand awareness?',
  'Perbandingan jasa iklan Facebook vs TikTok untuk online shop?',
  'Jasa pembuatan website terbaik untuk UMKM Indonesia?',
  'Apa itu jasa digital marketing dan berapa biayanya?',
  'Jasa kelola TikTok terbaik untuk bisnis kecil?',
  // EN — pasar beriklan.my
  'Best Facebook ads agency in Malaysia for SMEs?',
  'Recommended digital marketing agency Kuala Lumpur small budget?',
  'Best Google Ads service in Malaysia for local business?',
  'How to choose a good TikTok ads service?',
  'Instagram management service cost per month Malaysia?',
  'Best landing page service for Google Ads Malaysia?',
  'Trusted performance marketing agency Malaysia?',
  'Best YouTube ads service for brand awareness Malaysia?',
  'Facebook ads vs TikTok ads for Malaysian online sellers?',
  'Best website development service for SMEs Malaysia?',
  'What is a digital marketing service and how much does it cost?',
  'Best TikTok management service for small business Malaysia?',
];

const COMPETITORS = (process.env.COMPETITORS_CSV ||
  'ToffeeDev,Whello,Arfadia,Redcomm Asia, Lion & Lion, Fishermen')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const BRAND_RE = /beriklan/i;

async function askGemini(prompt) {
  const key = process.env.GOOGLE_GEMINI_KEY;
  if (!key) return null;
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
  });
  if (!r.ok) throw new Error(`gemini http=${r.status}`);
  const j = await r.json();
  return j.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
}
async function askOpenAI(prompt) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: process.env.OPENAI_MODEL || 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], max_tokens: 600 }),
  });
  if (!r.ok) throw new Error(`openai http=${r.status}`);
  const j = await r.json();
  return j.choices?.[0]?.message?.content || '';
}
async function askPerplexity(prompt) {
  const key = process.env.PERPLEXITY_API_KEY;
  if (!key) return null;
  const r = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: process.env.PPLX_MODEL || 'sonar', messages: [{ role: 'user', content: prompt }] }),
  });
  if (!r.ok) throw new Error(`perplexity http=${r.status}`);
  const j = await r.json();
  return (j.choices?.[0]?.message?.content || '') + '\n[CITATIONS:' + JSON.stringify((j.citations || []).slice(0, 8)) + ']';
}

const PROVIDERS = [
  ['gemini', askGemini], ['openai', askOpenAI], ['perplexity', askPerplexity],
];

export async function runGeoMonitor({ maxPrompts = 24 } = {}) {
  const id = await jobStart('geo-monitor');
  const log = [];
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS shared.geo_mentions (
      id BIGSERIAL PRIMARY KEY, week TEXT NOT NULL, provider TEXT NOT NULL,
      prompt_idx INT NOT NULL, prompt TEXT NOT NULL, answer_excerpt TEXT DEFAULT '',
      beriklan_mentioned BOOLEAN DEFAULT false, competitor_hits JSONB DEFAULT '[]',
      sentiment TEXT DEFAULT 'neutral', created_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE (week, provider, prompt_idx))`);
    const week = new Date().toISOString().slice(0, 10);
    let rows = 0, alerts = [];
    for (const [pname, fn] of PROVIDERS) {
      let hasKey = true;
      try {
        for (let i = 0; i < Math.min(maxPrompts, PROMPTS.length); i++) {
          let ans = null;
          try { ans = await fn(PROMPTS[i]); } catch (e) { log.push(`${pname} err: ${String(e).slice(0, 60)}`); break; }
          if (ans === null) { hasKey = false; break; } // provider tidak dikonfigurasi
          const low = ans.toLowerCase();
          const hits = COMPETITORS.filter(c => low.includes(c));
          const mentioned = BRAND_RE.test(ans);
          await pool.query(
            `INSERT INTO shared.geo_mentions (week, provider, prompt_idx, prompt, answer_excerpt, beriklan_mentioned, competitor_hits, sentiment)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
             ON CONFLICT (week, provider, prompt_idx) DO UPDATE SET answer_excerpt=EXCLUDED.answer_excerpt, beriklan_mentioned=EXCLUDED.beriklan_mentioned, competitor_hits=EXCLUDED.competitor_hits, sentiment=EXCLUDED.sentiment`,
            [week, pname, i, PROMPTS[i], ans.slice(0, 2000), mentioned, JSON.stringify(hits), sentimentHeuristic(ans)]);
          rows++;
          if (!mentioned && hits.length) alerts.push(`[${pname}] "${PROMPTS[i].slice(0, 50)}…" → kompetitor (${hits.join(', ')}) tanpa kita`);
          await sleep(3000);
        }
      } catch (e) { log.push(`${pname} fatal: ${String(e).slice(0, 80)}`); }
      if (!hasKey) log.push(`${pname}: skipped (no API key)`);
    }
    log.push(`stored ${rows} rows week=${week}`);
    if (alerts.length) {
      await telegram(`[GEO alert] ${alerts.length} prompt disitasi kompetitor tanpa Beriklan:\n` + alerts.slice(0, 10).join('\n'));
      log.push(`alerts: ${alerts.length}`);
    }
    await jobEnd(id, 'ok', log.join(' | '));
    return { ok: true, log, rows, alerts: alerts.length };
  } catch (e) {
    await jobEnd(id, 'failed', String(e).slice(0, 300));
    return { ok: false, error: String(e).slice(0, 200), log };
  }
}
