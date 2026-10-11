// netlify/functions/health-sync.js
//
// Receives Garmin data from Apple Health, sent by the "Log Health Sync" iOS
// Shortcut (all Health reads use Source = Connect, so numbers match Garmin).
//
//   POST /api/health-sync   (header x-sync-key: HEALTH_SYNC_KEY)
//     JSON body, every list is newline-separated text built by the Shortcut:
//       profile_id : "..."
//       steps      : "2026-10-09|16234\n2026-10-10|9120"
//       active     : "2026-10-09|610\n..."          (Active Energy, kcal)
//       resting    : "2026-10-09|2253\n..."         (Resting Energy, kcal)
//       steps_watch / active_watch / resting_watch     same, Source = Apple Watch
//                    (covers Apple Watch days — see the per-field rule below)
//       workouts   : "Running|2026-10-10 09:34|2026-10-10 10:05|214|3.31\n..."
//                    activity | start | end | kcal | distance (optional)
//     → upserts health_daily (one row per day) and exercise_logs (one row per
//       workout, source 'health'). Re-sending the same days is safe.
//
//   GET /api/health-sync?profile_id=...&days=120   → health_daily rows (for the app)

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const SYNC_KEY = process.env.HEALTH_SYNC_KEY;

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-sync-key',
};
const json = (statusCode, body) => ({ statusCode, headers, body: JSON.stringify(body) });

async function sb(path, init = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

// "1,983.097 Cal" → 1983.097 ; "" → null
function num(v) {
  const m = String(v ?? '').replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}
// A real calendar date (rejects things like 2026-29-14 from a lowercase-mm format)
function isDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}
// Plausible daily ranges — anything outside is a Shortcut wiring mistake, not data
const LIMITS = { steps: [1, 100000], active: [1, 6000], resting: [800, 4500] }; // same bounds as the app
const inLimits = (k, v) => v >= LIMITS[k][0] && v <= LIMITS[k][1];
const lines = t => String(t || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
// "2026-10-10 09:34" or "2026-10-10T09:34:00" → Date treated as local wall time
function wall(s) {
  const m = String(s || '').match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})/);
  return m && isDate(`${m[1]}-${m[2]}-${m[3]}`) ? { date: `${m[1]}-${m[2]}-${m[3]}`, mins: Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) / 60000, iso: `${m[1]}-${m[2]}-${m[3]}T${m[4].padStart(2, '0')}:${m[5]}` } : null;
}

// Parses "date|value" lines into { date: value }
function dayValues(text) {
  const out = {};
  lines(text).forEach(l => {
    const [d, v] = l.split('|');
    const date = (d || '').trim().slice(0, 10), val = num(v);
    if (isDate(date) && val != null) out[date] = Math.round(val);
  });
  return out;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (!SUPABASE_URL || !SUPABASE_KEY) return json(500, { error: 'Supabase env vars not configured' });

  // ── App reads ──
  if (event.httpMethod === 'GET') {
    const q = event.queryStringParameters || {};
    if (!q.profile_id) return json(400, { error: 'profile_id required' });
    const days = Math.min(parseInt(q.days) || 120, 800);
    const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
    try {
      const rows = await sb(`health_daily?profile_id=eq.${encodeURIComponent(q.profile_id)}&date=gte.${since}&order=date.asc`);
      return json(200, rows || []);
    } catch (e) { return json(500, { error: e.message }); }
  }
  if (event.httpMethod !== 'POST') return json(405, { error: 'Use GET or POST' });

  // ── Shortcut writes ──
  if (!SYNC_KEY) return json(500, { error: 'HEALTH_SYNC_KEY not configured in Netlify' });
  const key = event.headers?.['x-sync-key'] || event.headers?.['X-Sync-Key'];
  if (key !== SYNC_KEY) return json(401, { error: 'Bad sync key' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (_) { return json(400, { error: 'Body must be JSON' }); }
  const profile_id = String(body.profile_id || '').trim();
  if (!profile_id) return json(400, { error: 'profile_id required' });

  try {
    // Daily totals — a zero/missing field never overwrites a real value,
    // so a day Garmin hasn't synced yet can't wipe out good data.
    // Per field, pick ONE source — never summed, so wearing both can't double count:
    //   steps / active: whichever watch recorded MORE that day (the one you actually
    //     wore; a watch put on briefly only has a partial count)
    //   resting: Garmin first (it reports a full day even when off the wrist)
    const g = { steps: dayValues(body.steps), active: dayValues(body.active), resting: dayValues(body.resting) };
    const w = { steps: dayValues(body.steps_watch), active: dayValues(body.active_watch), resting: dayValues(body.resting_watch) };
    const dates = [...new Set([...Object.values(g), ...Object.values(w)].flatMap(Object.keys))];
    let skipped = 0, watchDays = 0;
    const byShape = {};
    dates.forEach(date => {
      const row = { profile_id, date, updated_at: new Date().toISOString() };
      const used = new Set();
      for (const [k, col] of [['steps', 'steps'], ['active', 'active_kcal'], ['resting', 'resting_kcal']]) {
        const gv = inLimits(k, g[k][date]) ? g[k][date] : null;
        const wv = inLimits(k, w[k][date]) ? w[k][date] : null;
        const useWatch = wv != null && (gv == null || (k !== 'resting' && wv > gv));
        if (useWatch) { row[col] = wv; used.add('apple_watch'); }
        else if (gv != null) { row[col] = gv; used.add('garmin'); }
        else if (g[k][date] > 0 || w[k][date] > 0) skipped++;
      }
      if (Object.keys(row).length <= 3) return;
      row.source = used.size > 1 ? 'mixed' : [...used][0];
      if (used.has('apple_watch')) watchDays++;
      const shape = Object.keys(row).sort().join(',');
      (byShape[shape] = byShape[shape] || []).push(row);
    });
    for (const rows of Object.values(byShape)) {
      await sb('health_daily?on_conflict=profile_id,date', {
        method: 'POST', body: JSON.stringify(rows),
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      });
    }

    // Workouts — one exercise_logs row each, keyed by start time + activity
    const workouts = lines(body.workouts).map(l => {
      const [activity, start, end, kcal, dist] = l.split('|').map(x => (x || '').trim());
      const s = wall(start), e = wall(end);
      if (!activity || !s) return null;
      const minutes = e && e.mins > s.mins ? Math.round(e.mins - s.mins) : null;
      return {
        profile_id, date: s.date, name: activity,
        calories_burned: Math.round(num(kcal) || 0),
        source: 'health', health_id: `${s.iso}|${activity}`,
        sport_type: activity, trainer: null,
        moving_time: minutes != null ? minutes * 60 : null,
      };
    }).filter(Boolean);
    if (workouts.length) {
      await sb('exercise_logs?on_conflict=profile_id,health_id', {
        method: 'POST', body: JSON.stringify(workouts),
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      });
    }

    const badLines = lines(body.workouts).length - workouts.length;
    const warn = skipped || badLines ? ` (skipped ${skipped + badLines} odd value${skipped + badLines === 1 ? '' : 's'} — check the Shortcut)` : '';
    const watchNote = watchDays ? ` (${watchDays} from Apple Watch)` : '';
    const message = `Lōg synced ${dates.length} day${dates.length === 1 ? '' : 's'}${watchNote} and ${workouts.length} workout${workouts.length === 1 ? '' : 's'}${warn}`;
    return json(200, { ok: true, days: dates.length, workouts: workouts.length, message });
  } catch (e) {
    console.error('[health-sync]', e.message);
    return json(500, { error: e.message, message: `Lōg sync failed: ${e.message.slice(0, 120)}` });
  }
};
