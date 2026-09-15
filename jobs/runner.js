// Job scheduler (node-cron, TZ=UTC). Single-run guard via in-memory set.
// Jadwal: news-ping 2-jam-an · distribute 6-jam-an · geo-monitor Senin · freshness harian.
import cron from 'node-cron';
import { runNewsPing } from './news-ping.js';
import { runDistribute } from './distribute.js';
import { runGeoMonitor } from './geo-monitor.js';
import { runFreshness } from './freshness.js';

const running = new Set();
export async function runOnce(name, opts = {}) {
  if (running.has(name)) return { ok: false, error: 'already_running' };
  running.add(name);
  try {
    if (name === 'news-ping') return await runNewsPing(opts);
    if (name === 'distribute') return await runDistribute(opts);
    if (name === 'geo-monitor') return await runGeoMonitor(opts);
    if (name === 'freshness') return await runFreshness(opts);
    return { ok: false, error: 'unknown_job (news-ping|distribute|geo-monitor|freshness)' };
  } finally { running.delete(name); }
}

export function startSchedules() {
  if (process.env.JOBS_ENABLED === '0') { console.log('[jobs] disabled via JOBS_ENABLED=0'); return; }
  cron.schedule('7 */2 * * *', () => runOnce('news-ping').then(r => console.log('[cron news-ping]', r.ok ? 'ok' : 'FAIL', JSON.stringify(r.log || r.error).slice(0, 200))), { timezone: 'UTC' });
  cron.schedule('23 */6 * * *', () => runOnce('distribute').then(r => console.log('[cron distribute]', r.ok ? 'ok' : 'FAIL', JSON.stringify(r.log || r.error).slice(0, 200))), { timezone: 'UTC' });
  cron.schedule('0 4 * * 1', () => runOnce('geo-monitor').then(r => console.log('[cron geo-monitor]', r.ok ? 'ok' : 'FAIL', JSON.stringify(r.log || r.error).slice(0, 200))), { timezone: 'UTC' });
  cron.schedule('0 5 * * *', () => runOnce('freshness').then(r => console.log('[cron freshness]', r.ok ? 'ok' : 'FAIL', JSON.stringify(r.log || r.error).slice(0, 200))), { timezone: 'UTC' });
  console.log('[jobs] schedules armed (UTC): news-ping 2h, distribute 6h, geo-monitor Mon, freshness daily');
}
