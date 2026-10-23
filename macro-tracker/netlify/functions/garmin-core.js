// netlify/functions/garmin-core.js — shared logic, not an endpoint (no handler)
//
// Pulls your own data from Garmin's Personal API (personal.connectapi.garmin.com)
// and saves it into Lōg's existing tables:
//   health_daily  — steps, active/resting kcal, resting HR, sleep, HRV,
//                   stress, Body Battery (source 'garmin_api')
//   exercise_logs — workouts (skipping ones the Shortcut already saved)
//   weights       — only days you haven't entered a weight yourself
//
// Garmin doesn't publish response schemas we can read, so every field is read
// defensively from a list of likely names, and each sync returns a REPORT of
// what came back (counts + field names, never values) so the mapping can be
// corrected from a screenshot.
//
// Env: GARMIN_PERSONAL_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY

const BASE = 'https://personal.connectapi.garmin.com';
const TOKEN_PATH = '/personalapitoken-service/personal-api/personal-api-key/token';
const SB_URL = process.env.SUPABASE_URL, SB_KEY = process.env.SUPABASE_SERVICE_KEY;
const LIMITS = { steps: [1, 100000], active_kcal: [1, 6000], resting_kcal: [800, 4500], resting_hr: [30, 120],
  sleep_min: [60, 960], sleep_score: [1, 100], hrv_ms: [5, 300], hrv_weekly: [5, 300], hrv_low: [5, 300], hrv_high: [5, 300],
  stress_avg: [1, 100], bb_high: [1, 100], bb_low: [0, 100] };

async function fetchT(url, opts = {}, ms = 8000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctl.signal }); } finally { clearTimeout(t); }
}

// ── Auth: key → 24h access token (cached while the function stays warm) ──
let cached = null;
async function getToken() {
  if (cached && Date.now() < cached.exp - 3600e3) return cached.token;
  const key = process.env.GARMIN_PERSONAL_API_KEY;
  if (!key) throw new Error('GARMIN_PERSONAL_API_KEY is not set in Netlify');
  const r = await fetchT(BASE + TOKEN_PATH, { method: 'POST', headers: { Authorization: `ApiKey ${key.trim()}` } });
  const text = await r.text();
  if (r.status === 401 || r.status === 403) throw new Error('Garmin rejected the API key (expired or deleted). Create a new one in Garmin Connect → Settings → Personal API and update GARMIN_PERSONAL_API_KEY in Netlify.');
  if (!r.ok) throw new Error(`Garmin token error ${r.status}: ${text.slice(0, 160)}`);
  let j; try { j = JSON.parse(text); } catch (_) { j = { access_token: text.trim() }; }
  const token = j.access_token || j.accessToken || j.token;
  if (!token) throw new Error('Garmin token response had no token (fields: ' + Object.keys(j).join(', ') + ')');
  cached = { token, exp: Date.now() + (Number(j.expires_in || j.expiresIn) || 86400) * 1000 };
  return token;
}
async function gget(path, params) {
  const token = await getToken();
  const qs = params ? '?' + new URLSearchParams(params).toString() : '';
  const r = await fetchT(BASE + path + qs, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  const text = await r.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch (_) {}
  return { ok: r.ok, status: r.status, json, text: r.ok ? '' : text.slice(0, 160) };
}

// ── Helpers ──
const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (s, n) => { const d = new Date(s + 'T12:00:00'); d.setDate(d.getDate() + n); return ymd(d); };
function chunks(start, end, size = 28) {
  const out = []; let s = start;
  while (s <= end) { const e = addDays(s, size - 1) < end ? addDays(s, size - 1) : end; out.push([s, e]); s = addDays(e, 1); }
  return out;
}
// First list of objects found in a response (array itself, or a known/any array property)
function listOf(json, preferred = []) {
  if (Array.isArray(json)) return json;
  if (!json || typeof json !== 'object') return [];
  for (const k of preferred) if (Array.isArray(json[k])) return json[k];
  const arr = Object.values(json).find(v => Array.isArray(v) && v.length && typeof v[0] === 'object');
  return arr || (json.calendarDate ? [json] : []);
}
// Read a value from an item by trying candidate names, also inside common nestings
function pick(item, names) {
  const spots = [item, item?.values, item?.summary, item?.dailySleepDTO, item?.hrvSummary, item?.allDayStress, item?.sleepScores?.overall];
  for (const o of spots) { if (!o || typeof o !== 'object') continue;
    for (const n of names) { const v = n.split('.').reduce((a, k) => (a == null ? a : a[k]), o); if (v != null && v !== '') return v; } }
  return null;
}
// Find a number inside a section (e.g. item.movement) whose field name matches
// one of the patterns, in priority order. A matching field that's itself an
// object ({ count, value, total }) is opened up.
function deepNum(obj, patterns, depth = 3) {
  if (!obj || typeof obj !== 'object' || depth < 0) return null;
  for (const re of patterns) {
    const hit = (o, d) => {
      if (!o || typeof o !== 'object' || Array.isArray(o) || d < 0) return null;
      for (const [k, v] of Object.entries(o)) {
        if (re.test(k)) {
          if (typeof v === 'number') return v;
          if (v && typeof v === 'object' && !Array.isArray(v)) {
            for (const kk of ['value', 'count', 'total', 'amount', 'avg', 'average']) if (typeof v[kk] === 'number') return v[kk];
          }
        }
      }
      for (const v of Object.values(o)) { const r = hit(v, d - 1); if (r != null) return r; }
      return null;
    };
    const r = hit(obj, depth); if (r != null) return r;
  }
  return null;
}
const dateOf = it => String(pick(it, ['calendarDate', 'summaryDate', 'date', 'startDate', 'startTimeLocal']) || '').slice(0, 10);
const inLimits = (k, v) => v != null && !isNaN(v) && v >= LIMITS[k][0] && v <= LIMITS[k][1];
// Field names for the report; sections show their inner fields: movement{steps,distance}
const keysOf = it => (it && typeof it === 'object' ? Object.entries(it).slice(0, 30).map(([k, v]) =>
  v && typeof v === 'object' && !Array.isArray(v) ? `${k}{${Object.entries(v).slice(0, 14).map(([kk, vv]) => vv && typeof vv === 'object' && !Array.isArray(vv) ? `${kk}{${Object.keys(vv).slice(0, 8).join(',')}}` : kk).join(',')}}` : k) : []);

async function sb(path, init = {}) {
  const r = await fetchT(`${SB_URL}/rest/v1/${path}`, { ...init, headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', ...(init.headers || {}) } }, 10000);
  const t = await r.text();
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
}

// ── Main ──
async function syncGarmin({ profileId, days = 8, end = null }) {
  if (!profileId) throw new Error('profile_id required');
  days = Math.max(1, Math.min(120, Number(days) || 8));
  const endDate = end || ymd(new Date());
  const startDate = addDays(endDate, -(days - 1));
  const report = {}, byDate = {};
  const row = d => (byDate[d] = byDate[d] || {});
  const note = (name, res, items) => { report[name] = { ok: res.ok, status: res.status, count: items.length, fields: keysOf(items[0]), error: res.text || undefined }; };
  const set = (d, k, v) => { if (d && inLimits(k, v != null ? Math.round(Number(v)) : null)) row(d)[k] = Math.round(Number(v)); };

  for (const [s, e] of chunks(startDate, endDate)) {
    // Daily summaries: steps, calories, resting HR, stress, Body Battery
    const ds = await gget('/usersummary-service/v2/dailysummaries', { startDate: s, endDate: e });
    const dl = listOf(ds.json, ['data', 'dailySummaries', 'summaries']);
    note('daily summaries', ds, dl);
    // v2 groups values into sections: movement, calories, heartRate, stress, bodyBattery
    dl.forEach(it => { const d = dateOf(it);
      set(d, 'steps', pick(it, ['totalSteps', 'steps']) ?? deepNum(it.movement, [/^(total)?steps$/i, /stepcount/i, /^steps?/i]));
      set(d, 'active_kcal', pick(it, ['activeKilocalories', 'activeCalories']) ?? deepNum(it.calories, [/^active(kilo)?cal(orie)?s?$/i, /^active$/i, /active/i]));
      set(d, 'resting_kcal', pick(it, ['bmrKilocalories', 'bmrCalories']) ?? deepNum(it.calories, [/^bmr/i, /^resting/i, /bmr|resting/i]));
      set(d, 'resting_hr', pick(it, ['restingHeartRate', 'restingHeartRateValue']) ?? deepNum(it.heartRate, [/^resting(heartrate|hr)?$/i, /^resting/i, /resting/i]));
      set(d, 'stress_avg', pick(it, ['averageStressLevel', 'avgStressLevel']) ?? deepNum(it.stress, [/^(avg|average)(stress)?(level)?$/i, /^overall/i, /avg|average/i]));
      set(d, 'bb_high', pick(it, ['bodyBatteryHighestValue']) ?? deepNum(it.bodyBattery, [/^(highest|max|high)(value)?$/i, /highest|max/i]));
      set(d, 'bb_low', pick(it, ['bodyBatteryLowestValue']) ?? deepNum(it.bodyBattery, [/^(lowest|min|low)(value)?$/i, /lowest|min/i]));
    });
    // HRV: overnight average, weekly average, status, baseline range
    const hv = await gget(`/hrv-service/hrv/daily/${s}/${e}`);
    const hl = listOf(hv.json, ['hrvSummaries', 'data']);
    note('hrv', hv, hl);
    hl.forEach(it => { const d = dateOf(it);
      set(d, 'hrv_ms', pick(it, ['lastNightAvg', 'lastNightAverage', 'overnightAvg']));
      set(d, 'hrv_weekly', pick(it, ['weeklyAvg', 'weeklyAverage']));
      set(d, 'hrv_low', pick(it, ['baseline.balancedLow', 'baselineLow']));
      set(d, 'hrv_high', pick(it, ['baseline.balancedUpper', 'baselineHigh']));
      const st = pick(it, ['status', 'hrvStatus']); if (d && st && typeof st === 'string') row(d).hrv_status = st.slice(0, 20).toLowerCase();
    });
    // Sleep: total time asleep (the night ending on that date) + sleep score
    const sl = await gget('/sleep-service/sleep/dailySleepSummariesByDate', { startDate: s, endDate: e });
    const sll = listOf(sl.json, ['dailySleepSummaries', 'sleepSummaries', 'data']);
    note('sleep', sl, sll);
    sll.forEach(it => { const d = dateOf(it);
      const secs = pick(it, ['sleepTimeSeconds', 'totalSleepSeconds', 'sleepTimeInSeconds']);
      const mins = secs != null ? secs / 60 : pick(it, ['sleepTimeMinutes', 'totalSleepMinutes']);
      set(d, 'sleep_min', mins);
      set(d, 'sleep_score', pick(it, ['sleepScores.overall.value', 'overall.value', 'overallSleepScore', 'sleepScore', 'value']));
    });
  }

  // Weight: only days without a weight you entered yourself
  let weightsAdded = 0;
  try {
    const wr = await gget(`/weight-service/weight/range/${startDate}/${endDate}`, { includeAll: 'true' });
    const wl = listOf(wr.json, ['dailyWeightSummaries', 'dateWeightList', 'weights', 'data']);
    note('weight', wr, wl);
    const have = new Set(((await sb(`weights?profile_id=eq.${profileId}&date=gte.${startDate}&date=lte.${endDate}&select=date`)) || []).map(r => r.date));
    const add = [];
    wl.forEach(it => {
      const d = dateOf(it) || String(pick(it, ['latestWeight.calendarDate']) || '').slice(0, 10);
      let w = pick(it, ['latestWeight.weight', 'weight', 'weightValue']);
      if (!d || w == null || have.has(d) || add.some(a => a.date === d)) return;
      w = Number(w); const lbs = w > 1000 ? w / 453.592 : w * 2.20462; // Garmin stores grams (or kg)
      if (lbs > 70 && lbs < 600) add.push({ profile_id: profileId, date: d, weight: Math.round(lbs * 10) / 10 });
    });
    if (add.length) { await sb('weights', { method: 'POST', body: JSON.stringify(add), headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' } }); weightsAdded = add.length; }
  } catch (e) { report.weight = { ...(report.weight || {}), error: e.message.slice(0, 160) }; }

  // Workouts: skip any the Shortcut already saved (same start time ±2 min)
  let workoutsAdded = 0, skippedShortcut = 0, refreshed = 0, dupesRemoved = 0; const dupes = [];
  try {
    const acts = [];
    for (let start = 0; start < 400; start += 100) {
      const ar = await gget('/activitylist-service/activities/search/activities', { start, limit: 100, startDate, endDate });
      const al = listOf(ar.json, ['activities', 'activityList', 'data']);
      if (start === 0) note('activities', ar, al);
      acts.push(...al); if (al.length < 100) break;
    }
    const existing = (await sb(`exercise_logs?profile_id=eq.${profileId}&date=gte.${startDate}&date=lte.${endDate}&select=health_id,source`)) || [];
    const haveGarmin = new Set(existing.map(r => String(r.health_id || '')).filter(h => h.startsWith('garmin:')));
    const taken = existing.filter(r => r.health_id && !String(r.health_id).startsWith('garmin:'))
      .map(r => { const m = String(r.health_id).match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})/); return m ? new Date(`${m[1]}T${m[2]}:${m[3]}:00`).getTime() : null; }).filter(Boolean);
    const title = s => String(s || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    const rows = acts.map(a => {
      const id = pick(a, ['activityId', 'id']); const startLocal = String(pick(a, ['startTimeLocal', 'startTime', 'beginTimestamp']) || '');
      const m = startLocal.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})/);
      if (!id || !m) return null;
      const t = new Date(`${m[1]}T${m[2]}:${m[3]}:00`).getTime();
      if (taken.some(x => Math.abs(x - t) <= 120000)) { // already saved by the Shortcut
        skippedShortcut++;
        if (haveGarmin.has(`garmin:${id}`)) dupes.push(`garmin:${id}`); // a copy slipped in earlier: remove it
        return null;
      }
      if (haveGarmin.has(`garmin:${id}`)) refreshed++;
      const type = title(pick(a, ['activityType.typeKey', 'activityTypeDTO.typeKey', 'activityType']) || 'workout');
      const secs = Number(pick(a, ['movingDuration', 'duration', 'elapsedDuration']) || 0);
      return { profile_id: profileId, date: m[1], name: String(pick(a, ['activityName']) || type).slice(0, 80),
        calories_burned: Math.round(Number(pick(a, ['calories', 'activeKilocalories']) || 0)), source: 'garmin',
        health_id: `garmin:${id}`, sport_type: type, trainer: null, moving_time: secs ? Math.round(secs) : null };
    }).filter(Boolean);
    if (rows.length) await sb('exercise_logs?on_conflict=profile_id,health_id', { method: 'POST', body: JSON.stringify(rows), headers: { Prefer: 'resolution=merge-duplicates,return=minimal' } });
    workoutsAdded = rows.length - refreshed;
    for (let i = 0; i < dupes.length; i += 50) {
      const ids = dupes.slice(i, i + 50).map(h => `"${h}"`).join(',');
      await sb(`exercise_logs?profile_id=eq.${profileId}&health_id=in.(${encodeURIComponent(ids)})`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
      dupesRemoved += Math.min(50, dupes.length - i);
    }
    report.workouts = { ok: true, count: acts.length, fields: [`${workoutsAdded} new`, `${skippedShortcut} already saved by the Shortcut`, `${refreshed} already synced from Garmin`, ...(dupesRemoved ? [`${dupesRemoved} duplicate${dupesRemoved === 1 ? '' : 's'} removed`] : [])] };
  } catch (e) { report.activities = { ...(report.activities || {}), error: e.message.slice(0, 160) }; }

  // Save daily rows (PostgREST bulk upserts need identical keys per batch)
  const now = new Date().toISOString(), groups = {};
  Object.entries(byDate).forEach(([date, r]) => {
    if (!Object.keys(r).length) return;
    const full = { profile_id: profileId, date, ...r, source: 'garmin_api', updated_at: now };
    const shape = Object.keys(full).sort().join(','); (groups[shape] = groups[shape] || []).push(full);
  });
  let saveError = null;
  try { for (const rows of Object.values(groups)) await sb('health_daily?on_conflict=profile_id,date', { method: 'POST', body: JSON.stringify(rows), headers: { Prefer: 'resolution=merge-duplicates,return=minimal' } }); }
  catch (e) { saveError = e.message.slice(0, 220); }

  // ── Habits that complete themselves (auto_source 'garmin:…') ──
  //   garmin:gym          strength / HIIT / cardio machines, 15+ min that day
  //   garmin:workout      any workout except walks, 15+ min
  //   garmin:sport:<word> an activity whose type or name contains <word> (e.g. pickleball)
  //   garmin:outdoor      an outdoor walk, run, hike or ride, 15+ min
  //   garmin:steps:<n>    at least n steps
  // Only ever ADDS a completion; never removes or changes one you entered.
  let habitsCompleted = 0;
  try {
    const habits = (await sb(`habits?profile_id=eq.${profileId}&auto_source=like.garmin*&select=id,name,auto_source,target_type,target_value`)) || [];
    if (habits.length) {
      const ex = (await sb(`exercise_logs?profile_id=eq.${profileId}&date=gte.${startDate}&date=lte.${endDate}&select=date,name,sport_type,moving_time`)) || [];
      const hd = (await sb(`health_daily?profile_id=eq.${profileId}&date=gte.${startDate}&date=lte.${endDate}&select=date,steps`)) || [];
      const steps = {}; hd.forEach(r => { steps[r.date] = r.steps; }); Object.entries(byDate).forEach(([d, r]) => { if (r.steps != null) steps[d] = r.steps; });
      const txt = e => `${e.sport_type || ''} ${e.name || ''}`.toLowerCase();
      const mins = e => (Number(e.moving_time) || 0) / 60;
      const indoor = e => /indoor|treadmill|virtual|trainer|elliptical/.test(txt(e));
      const isWalk = e => /walk/.test(txt(e)) && !indoor(e);
      const isGym = e => !isWalk(e) && /strength|weight|lift|hiit|functional|crossfit|core|cardio|elliptical|stair|row|spin|indoor cycl|treadmill|bootcamp|training/.test(txt(e));
      const isOutdoor = e => !indoor(e) && /walk|run|hik|trail|cycl|bik|ride|golf/.test(txt(e));
      const byDay = {}; ex.forEach(e => (byDay[e.date] = byDay[e.date] || []).push(e));
      const dates = []; for (let d = startDate; d <= endDate; d = addDays(d, 1)) dates.push(d);
      const rule = (src, d) => {
        const list = byDay[d] || [];
        const [, kind, arg] = String(src).split(':');
        const total = f => list.filter(f).reduce((a, e) => a + mins(e), 0);
        if (kind === 'gym') return total(isGym) >= 15;
        if (kind === 'workout') return total(e => !isWalk(e)) >= 15;
        if (kind === 'outdoor') return total(isOutdoor) >= 15;
        if (kind === 'sport') return !!arg && list.some(e => txt(e).includes(arg.toLowerCase()));
        if (kind === 'steps') return steps[d] != null && steps[d] >= (Number(arg) || 15000);
        return false;
      };
      const rows = [], names = {};
      habits.forEach(h => dates.forEach(d => { if (rule(h.auto_source, d)) {
        rows.push({ habit_id: h.id, profile_id: profileId, date: d, value: h.target_type === 'quantity' ? (Number(h.target_value) || 1) : 1 });
        names[h.name] = (names[h.name] || 0) + 1; } }));
      if (rows.length) await sb('habit_logs?on_conflict=habit_id,date', { method: 'POST', body: JSON.stringify(rows), headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' } });
      habitsCompleted = rows.length;
      report.habits = { ok: true, count: habits.length, fields: Object.entries(names).map(([n, c]) => `${n}: ${c} day${c === 1 ? '' : 's'}`) };
    }
  } catch (e) { report.habits = { ok: false, count: 0, fields: [], error: e.message.slice(0, 160) }; }

  const dayCount = Object.keys(byDate).length;
  const got = k => Object.values(byDate).filter(r => r[k] != null).length;
  return {
    ok: !saveError, error: saveError ? `Saving failed: ${saveError}` : undefined, range: [startDate, endDate], days: dayCount,
    found: { steps: got('steps'), calories: got('active_kcal'), resting_hr: got('resting_hr'), sleep: got('sleep_min'), hrv: got('hrv_ms'), stress: got('stress_avg'), body_battery: got('bb_high') },
    workoutsAdded, weightsAdded, habitsCompleted, report,
    message: `Garmin synced ${dayCount} day${dayCount === 1 ? '' : 's'}${workoutsAdded ? `, ${workoutsAdded} new workout${workoutsAdded === 1 ? '' : 's'}` : ''}${dupesRemoved ? `, removed ${dupesRemoved} duplicate${dupesRemoved === 1 ? '' : 's'}` : ''}${weightsAdded ? `, ${weightsAdded} weigh-in${weightsAdded === 1 ? '' : 's'}` : ''}`,
  };
}

module.exports = { syncGarmin, addDays, ymd };
