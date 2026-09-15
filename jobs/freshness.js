// C4. Freshness rewriter (harian): kandidat artikel lama ber-impresi (GSC SA) →
// draft callout update via AI → antre ke publish_outbox status 'draft' (APPROVAL
// manual: UPDATE status='ready' sebelum edge berani pull).
// Tanpa GSC_SA_JSON / AI key: skip tercatat (bukan error). Preview deterministik
// selalu tersedia via endpoint (tanpa AI).
import { pool, jobStart, jobEnd } from './lib.js';

export function buildFreshnessCallout({ title, lang = 'id', year = new Date().getFullYear() }) {
  const t = (title || 'artikel ini').slice(0, 90);
  if (lang === 'ms') {
    return `<div class="freshness-update"><p><strong>Kemas kini ${year}:</strong> Panduan "${t}" ini telah disemak semula dengan harga pasaran dan dasar pengiklanan terkini.</p><ul><li>Semakan harga & pakej semasa</li><li>Langkah disahkan dengan polisi ads terbaru</li><li>Contoh kes tempatan ditambah</li></ul></div>`;
  }
  return `<div class="freshness-update"><p><strong>Update ${year}:</strong> Panduan "${t}" ini telah ditinjau ulang dengan harga pasar dan kebijakan iklan terbaru.</p><ul><li>Review harga & paket terkini</li><li>Langkah divalidasi dengan policy ads terbaru</li><li>Contoh kasus lokal ditambahkan</li></ul></div>`;
}

async function callAi(systemPrompt, userPrompt) {
  // Zen free dulu, lalu Groq — key dari env (sama seperti edge).
  const zenKey = process.env.ZEN_API_KEY;
  const groqKeys = [process.env.GROQ_API_KEY_1, process.env.GROQ_API_KEY_2, process.env.GROQ_API_KEY_3].filter(Boolean);
  const models = ['big-pickle', 'mimo-v2.5-free', 'hy3-free', 'nemotron-3-ultra-free'];
  if (zenKey) {
    for (const m of models) {
      try {
        const r = await fetch('https://api.opencode.ai/zen/v1/chat/completions', {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${zenKey}` },
          body: JSON.stringify({ model: m, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }], max_tokens: 800 }),
        });
        if (r.ok) {
          const j = await r.json();
          const t = (j.choices?.[0]?.message?.content || '').trim();
          if (t.length > 50) return t;
        }
      } catch {}
    }
  }
  if (groqKeys.length) {
    try {
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${groqKeys[0]}` },
        body: JSON.stringify({ model: 'openai/gpt-oss-20b', reasoning_effort: 'low', max_tokens: 1024, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }] }),
      });
      if (r.ok) {
        const j = await r.json();
        const t = (j.choices?.[0]?.message?.content || '').trim();
        if (t.length > 50) return t;
      }
    } catch {}
  }
  return null;
}

export async function runFreshness({ count = 3 } = {}) {
  const id = await jobStart('freshness');
  const log = [];
  try {
    if (!process.env.GSC_SA_JSON) {
      log.push('skipped: need GSC_SA_JSON (candidate source)');
      await jobEnd(id, 'ok', log.join(' | '));
      return { ok: true, skipped: true, log };
    }
    // TODO Fase 3: query GSC API (searchanalytics) artikel >90 hari ber-impresi.
    // Kerangka siap; kandidat → callAi → outbox status 'draft'.
    log.push('GSC present — full candidate query menyusul Fase 3 (butuh service-account auth flow)');
    await jobEnd(id, 'ok', log.join(' | '));
    return { ok: true, log };
  } catch (e) {
    await jobEnd(id, 'failed', String(e).slice(0, 300));
    return { ok: false, error: String(e).slice(0, 200), log };
  }
}

// Dipakai endpoint preview + antre manual (tanpa AI bila key kosong → template deterministik).
export async function queueFreshnessDraft({ domain, slug, title, lang = 'id', useAi = true }) {
  if (!['comy', 'coid'].includes(domain)) return { ok: false, error: 'bad domain' };
  let callout = buildFreshnessCallout({ title, lang });
  if (useAi) {
    const ai = await callAi(
      'Kamu editor SEO. Tulis callout update HTML ringkas (<div class="freshness-update"> + 1 <p> + 3 <li>), jujur, tanpa klaim baru.',
      `Judul artikel: "${title}". Bahasa: ${lang === 'ms' ? 'Melayu Malaysia' : 'Indonesia'}. Tahun: ${new Date().getFullYear()}. Output HANYA HTML.`);
    if (ai) callout = ai;
  }
  const fslug = `${slug}-freshness-${new Date().getFullYear()}`;
  await pool.query(
    `INSERT INTO ${domain}.publish_outbox (slug, title, content, service, city, language, status)
     VALUES ($1,$2,$3,'freshness','', $4, 'draft')
     ON CONFLICT (slug) DO UPDATE SET content=EXCLUDED.content, status='draft'`,
    [fslug, `[Update] ${title}`, callout, lang]);
  return { ok: true, slug: fslug, status: 'draft', ai: useAi };
}
