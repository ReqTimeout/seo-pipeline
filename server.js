// seo-pipeline internal API v0 — Hono + pg. Internal only (CF-IP allowlist + bearer).
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import { Pool } from 'pg';
import { createRequire } from 'module';
import { timingSafeEqual } from 'crypto';
import { runOnce, startSchedules } from './jobs/runner.js';
import { buildFreshnessCallout, queueFreshnessDraft } from './jobs/freshness.js';
import { youtubeDescription, directoryProfile } from './jobs/earned-media.js';

const require = createRequire(import.meta.url);
const VERSION = '0.1.0';
const PORT = parseInt(process.env.PORT || '3000', 10);

const app = new Hono();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  connectionTimeoutMillis: 5000,
});

// ── Cloudflare IP allowlist (snapshot + 24h refresh, fail-soft) ──
let cfNets = [];
try { cfNets = require('./cf-ips.snapshot.json'); } catch { cfNets = { v4: [], v6: [] }; }
let cfList = [...(cfNets.v4 || []), ...(cfNets.v6 || [])];
async function refreshCfIps() {
  try {
    const [v4, v6] = await Promise.all([
      fetch('https://www.cloudflare.com/ips-v4').then(r => r.text()),
      fetch('https://www.cloudflare.com/ips-v6').then(r => r.text()),
    ]);
    const list = [...v4.split('\n'), ...v6.split('\n')].map(s => s.trim()).filter(Boolean);
    if (list.length > 10) { cfList = list; console.log('[net] CF IP list refreshed:', list.length); }
  } catch (e) { console.log('[net] CF IP refresh failed, keeping last good:', String(e).slice(0, 80)); }
}
refreshCfIps();
setInterval(refreshCfIps, 24 * 3600 * 1000);

function ipInCidr(ip, cidr) {
  // minimal v4/v6 prefix matcher (no deps)
  try {
    const [net, bits] = cidr.split('/');
    const n = parseInt(bits, 10);
    const v6 = net.includes(':');
    if (v6 !== ip.includes(':')) return false;
    const toBig = (s) => {
      if (!s.includes(':')) return s.split('.').reduce((a, p) => (a << 8n) + BigInt(p), 0n);
      const full = s.split('::');
      let groups = [];
      if (full.length === 2) {
        const l = full[0] ? full[0].split(':') : [], r = full[1] ? full[1].split(':') : [];
        groups = [...l, ...Array(8 - l.length - r.length).fill('0'), ...r];
      } else groups = s.split(':');
      return groups.reduce((a, g) => (a << 16n) + BigInt('0x' + (g || '0')), 0n);
    };
    const maxBits = v6 ? 128 : 32;
    const mask = ((1n << BigInt(n)) - 1n) << BigInt(maxBits - n);
    return (toBig(ip) & mask) === (toBig(net) & mask);
  } catch { return false; }
}
function clientIp(c) {
  // Socket peer IP is authoritative (host network mode → real client IP).
  // Forwarded headers are attacker-spoofable here → NEVER trusted for the allowlist.
  try {
    const info = getConnInfo(c);
    const addr = info?.remote?.address || '';
    if (addr) {
      const clean = String(addr).replace(/^::ffff:/, '');
      if (process.env.DEBUG_IP === 'once' && !globalThis.__ipLogged) {
        globalThis.__ipLogged = true;
        console.log('[net] observed peer ip:', clean);
      }
      return clean;
    }
  } catch {}
  return 'unknown';
}
function ipAllowed(ip) {
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return true;
  // RFC1918: Docker bridge/gateway IPs (host-originated traffic incl. orchestrator
  // healthchecks). Token auth tetap wajib untuk semua endpoint kecuali /v1/health.
  if (ipInCidr(ip, '10.0.0.0/8') || ipInCidr(ip, '172.16.0.0/12') || ipInCidr(ip, '192.168.0.0/16')) return true;
  return cfList.some(cidr => ipInCidr(ip, cidr));
}

// ── rate limit (in-memory, 120 req/min/IP) ──
const hits = new Map();
function rateOk(ip) {
  const now = Date.now(), win = 60_000, max = 120;
  const arr = (hits.get(ip) || []).filter(t => now - t < win);
  arr.push(now); hits.set(ip, arr);
  if (hits.size > 5000) for (const k of [...hits.keys()].slice(0, 1000)) hits.delete(k);
  return arr.length <= max;
}

app.use('*', async (c, next) => {
  const ip = clientIp(c);
  if (!rateOk(ip)) return c.json({ ok: false, error: 'rate_limited' }, 429);
  c.set('ip', ip);
  await next();
});

function bearerOk(c) {
  const hdr = c.req.header('authorization') || '';
  const want = process.env.PIPELINE_TOKEN || '';
  if (!want || !hdr.startsWith('Bearer ')) return false;
  const got = hdr.slice(7);
  if (got.length !== want.length) return false;
  try { return timingSafeEqual(Buffer.from(got), Buffer.from(want)); } catch { return false; }
}

// IP gate applies to everything EXCEPT health gets same gate too (stealth > convenience).
app.use('/v1/*', async (c, next) => {
  const ip = c.get('ip');
  if (!ipAllowed(ip)) { console.log('[deny] ip not allowed'); return c.json({ ok: false, error: 'forbidden' }, 403); }
  if (c.req.path !== '/v1/health' && !bearerOk(c)) return c.json({ ok: false, error: 'unauthorized' }, 401);
  await next();
});

app.get('/v1/health', (c) => c.json({ ok: true, service: 'seo-pipeline', version: VERSION, time: new Date().toISOString() }));
// Root health (Coolify/orchestrator healthcheck hits / and expects 200).
app.get('/', (c) => c.json({ ok: true, service: 'seo-pipeline', version: VERSION }));

const DOMAINS = { comy: 'comy', coid: 'coid' };

app.get('/v1/publish-ready', async (c) => {
  const domain = c.req.query('domain');
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '30', 10)));
  if (!DOMAINS[domain]) return c.json({ ok: false, error: 'bad domain (comy|coid)' }, 400);
  try {
    const { rows } = await pool.query(
      `SELECT slug, title, content, service, city, language FROM ${domain}.publish_outbox WHERE status='ready' ORDER BY created_at ASC LIMIT $1`,
      [limit]
    );
    return c.json({ ok: true, items: rows });
  } catch (e) { return c.json({ ok: false, error: String(e.message || e).slice(0, 150) }, 500); }
});

app.post('/v1/publish-ack', async (c) => {
  const domain = c.req.query('domain');
  let body = {};
  try { body = await c.req.json(); } catch {}
  const slugs = Array.isArray(body.slugs) ? body.slugs.filter(s => typeof s === 'string').slice(0, 100) : [];
  if (!DOMAINS[domain] || slugs.length === 0) return c.json({ ok: false, error: 'bad domain or empty slugs' }, 400);
  try {
    const { rowCount } = await pool.query(
      `UPDATE ${domain}.publish_outbox SET status='handed', handed_at=now() WHERE slug = ANY($1) AND status='ready'`,
      [slugs]
    );
    return c.json({ ok: true, acked: rowCount });
  } catch (e) { return c.json({ ok: false, error: String(e.message || e).slice(0, 150) }, 500); }
});

app.get('/v1/rank-deltas', async (c) => {
  // v0 stub — Fase 3 fills this. Returns empty (edge treats as no-op).
  return c.json({ ok: true, deltas: [] });
});

// Manual job trigger + status (auth). Cron otomatis jalan via startSchedules().
app.post('/v1/jobs/run/:name', async (c) => {
  const r = await runOnce(c.req.param('name'));
  return c.json(r, r.ok ? 200 : 400);
});
app.get('/v1/jobs/status', async (c) => {
  try {
    const { rows } = await pool.query(
      `SELECT job, status, detail, started_at, ended_at FROM shared.job_runs ORDER BY id DESC LIMIT 20`);
    return c.json({ ok: true, runs: rows });
  } catch (e) { return c.json({ ok: false, error: String(e.message || e).slice(0, 120) }, 500); }
});

// Freshness preview/queue (deterministic callout; AI bila key ada + queue=1).
app.post('/v1/freshness/preview', async (c) => {
  let b = {};
  try { b = await c.req.json(); } catch {}
  if (b.queue) return c.json(await queueFreshnessDraft({ domain: b.domain, slug: b.slug, title: b.title, lang: b.lang || 'id', useAi: b.useAi !== false }));
  return c.json({ ok: true, callout: buildFreshnessCallout({ title: b.title || '', lang: b.lang || 'id' }) });
});

// Earned-media helpers (deterministik).
app.post('/v1/earned-media/youtube', async (c) => {
  let b = {};
  try { b = await c.req.json(); } catch {}
  return c.json({ ok: true, description: youtubeDescription({ topic: b.topic, url: b.url, lang: b.lang || 'id' }) });
});
app.get('/v1/earned-media/nap', async (c) => c.json({ ok: true, profile: directoryProfile() }));

app.notFound((c) => c.json({ ok: false, error: 'not_found' }, 404));
app.onError((e, c) => { console.log('[err]', String(e?.message || e).slice(0, 150)); return c.json({ ok: false, error: 'internal' }, 500); });

export default { port: PORT, fetch: app.fetch };
startSchedules();
serve({ fetch: app.fetch, port: PORT },
  (i) => console.log('[up] seo-pipeline v' + VERSION + ' on :' + i.port));
