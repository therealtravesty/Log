// netlify/functions/coach-checkin.js
//
// POST /api/coach-checkin  { profile_id, today, goals: {cal,pro,carb,fat}, target: {...}, notes }
// (GET with the same fields as query params still works.)
//
// Builds a "where you are vs. where you planned to be" picture from weight,
// activity (Strava + manual), habits, and food logs, plus the user's own notes,
// then asks Claude for a short coaching read.
//
// All dates are anchored to the user's LOCAL `today` sent by the app — the
// server runs in UTC, which would otherwise shift days after 8pm Eastern.
//
// Returns: { message, generated_at, data_summary }

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const MODELS = ['claude-sonnet-5-5', 'claude-haiku-4-5-20251001']; // first that works

// Outdoor walks/hikes support the step goal; everything else is a workout.
// Works for Strava sport_types ("Walk", "Hike") and Apple Health names
// ("Walking", "Hiking", "Outdoor Walk"); treadmill/indoor walks count.
function isWorkoutRow(e) {
  if (e.source === 'strava' && e.trainer) return true;
  const t = String(e.sport_type || e.name || '');
  return !(/walk|hik/i.test(t) && !/treadmill|indoor/i.test(t));
}

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const json = (statusCode, body) => ({ statusCode, headers, body: JSON.stringify(body) });

async function sb(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

// ── Date helpers (pure YYYY-MM-DD strings, no time zones) ──
const toDate = s => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const fromDate = d => d.toISOString().slice(0, 10);
const addDays = (s, n) => { const d = toDate(s); d.setUTCDate(d.getUTCDate() + n); return fromDate(d); };
const daysBetween = (a, b) => Math.round((toDate(b) - toDate(a)) / 864e5);
const weekStart = s => { const d = toDate(s); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return fromDate(d); }; // Monday
const inRange = (d, from, to) => d >= from && d <= to;
const round1 = n => Math.round(n * 10) / 10;
const signed = n => (n > 0 ? '+' : n < 0 ? '−' : '±') + Math.abs(n);

function sumMacros(rows) {
  return rows.reduce((a, r) => ({
    cal: a.cal + (r.cal || 0), pro: a.pro + (r.pro || 0), carb: a.carb + (r.carb || 0),
    fat: a.fat + (r.fat || 0), sug: a.sug + (r.sug || 0),
    sod: a.sod + (r.sod || 0), fib: a.fib + (r.fib || 0), sat: a.sat + (r.sat_fat || 0),
  }), { cal: 0, pro: 0, carb: 0, fat: 0, sug: 0, sod: 0, fib: 0, sat: 0 });
}

// Least-squares slope of weight over time → lbs per week
function weeklyRate(points) {
  if (points.length < 3) return null;
  const x0 = toDate(points[0].date);
  const xs = points.map(p => (toDate(p.date) - x0) / 864e5), ys = points.map(p => p.lbs);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
  const num = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0);
  const den = xs.reduce((a, x) => a + (x - mx) ** 2, 0);
  return den ? round1(num / den * 7) : null;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (!['GET', 'POST'].includes(event.httpMethod)) return json(405, { error: 'Method not allowed' });
  if (!SUPABASE_URL || !SUPABASE_KEY || !ANTHROPIC_KEY) return json(500, { error: 'env vars not configured' });

  let input = {};
  if (event.httpMethod === 'POST') { try { input = JSON.parse(event.body || '{}'); } catch (_) {} }
  else {
    const q = event.queryStringParameters || {};
    input = { profile_id: q.profile_id, today: q.today, notes: q.notes, goals: { cal: q.cal, pro: q.pro, carb: q.carb, fat: q.fat } };
  }
  const profile_id = input.profile_id;
  if (!profile_id) return json(400, { error: 'profile_id required' });
  const today = /^\d{4}-\d{2}-\d{2}$/.test(input.today || '') ? input.today : fromDate(new Date());
  const notes = String(input.notes || '').trim().slice(0, 1500);
  const g = input.goals || {};
  const goals = { cal: parseInt(g.cal) || null, pro: parseInt(g.pro) || null, carb: parseInt(g.carb) || null, fat: parseInt(g.fat) || null };
  const target = input.target || {}; // { source: 'garmin'|'estimate', tdee, days }
  const fq = input.quality && typeof input.quality === 'object' ? input.quality : null; // { score, upfPct, coverage, days }

  try {
    const pid = encodeURIComponent(profile_id);
    const since = addDays(today, -120);
    const safe = p => sb(p).catch(e => { console.warn('[coach] fetch failed:', p, e.message); return []; });
    const [foodRows, weightRows, exerciseRows, settingsRows, habitsRows, habitLogRows, healthRows] = await Promise.all([
      safe(`food_logs?profile_id=eq.${pid}&date=gte.${since}&order=date.asc&limit=100000`),
      safe(`weights?profile_id=eq.${pid}&order=date.asc&limit=100000`),
      safe(`exercise_logs?profile_id=eq.${pid}&date=gte.${since}&order=date.asc&limit=100000`),
      safe(`settings?profile_id=eq.${pid}`),
      safe(`habits?profile_id=eq.${pid}&order=sort_order.asc`),
      safe(`habit_logs?profile_id=eq.${pid}&date=gte.${since}&order=date.asc&limit=100000`),
      safe(`health_daily?profile_id=eq.${pid}&date=gte.${since}&order=date.asc`),
    ]);
    const settings = (settingsRows && settingsRows[0] && settingsRows[0].data) || {};

    // ── Plan ──
    const goal = settings.goal || 'cut';
    const rate = parseFloat(settings.rate || '1') || 0;
    const plannedRate = goal === 'cut' ? -rate : goal === 'bulk' ? rate : 0; // lbs/week
    const plannedSessions = 6; // trains 6x/week (also baked into the TDEE multiplier)

    // ── Weight ──
    const weights = (weightRows || []).filter(w => w.weight && w.date <= today).map(w => ({ date: w.date, lbs: parseFloat(w.weight) }));
    const latest = weights[weights.length - 1] || null;
    const avgIn = (from, to) => { const p = weights.filter(w => inRange(w.date, from, to)); return p.length ? round1(p.reduce((a, w) => a + w.lbs, 0) / p.length) : null; };
    const avg7 = avgIn(addDays(today, -6), today), avgPrev7 = avgIn(addDays(today, -13), addDays(today, -7));
    const rate28 = weeklyRate(weights.filter(w => w.date >= addDays(today, -27)));
    const n28 = weights.filter(w => w.date >= addDays(today, -27)).length;
    const w90 = weights.find(w => w.date >= addDays(today, -89));
    let paceLabel = 'not enough weigh-ins to judge pace';
    // Pace gap in lb/week: positive = losing slower (or gaining) vs plan
    const paceGap = rate28 != null && n28 >= 6 ? round1(rate28 - plannedRate) : null;
    if (rate28 != null) {
      const gap = round1(rate28 - plannedRate);
      paceLabel = goal === 'cut'
        ? (rate28 > 0 ? `gaining (${signed(rate28)} lb/wk) while the plan is to lose ${rate} lb/wk — off plan`
          : Math.abs(gap) <= 0.3 ? `on pace (${signed(rate28)} lb/wk vs planned −${rate})`
          : gap > 0 ? `losing slower than planned (${signed(rate28)} lb/wk vs −${rate})`
          : `losing faster than planned (${signed(rate28)} lb/wk vs −${rate})`)
        : `${signed(rate28)} lb/wk vs planned ${signed(plannedRate)}`;
    }

    // ── Activity (Strava + manual) by Monday-start week ──
    const ex = (exerciseRows || []).filter(e => e.date <= today);
    const isWorkout = e => (e.source === 'manual' || !e.source) ? true : isWorkoutRow(e);
    const thisWeek = weekStart(today);
    const weeks = [0, 1, 2, 3].map(i => {
      const from = addDays(thisWeek, -7 * i), to = addDays(from, 6);
      const rows = ex.filter(e => inRange(e.date, from, to));
      const workoutDays = new Set(rows.filter(isWorkout).map(e => e.date)).size;
      const workoutMins = Math.round(rows.filter(isWorkout).reduce((a, e) => a + (e.moving_time || 0), 0) / 60);
      const walks = rows.filter(e => !isWorkout(e)).length;
      const isStrength = e => /strength|weight|lift|functional|crossfit|core|hiit|resistance/i.test(`${e.sport_type || ''} ${e.name || ''}`);
      const strengthDays = new Set(rows.filter(e => isWorkout(e) && isStrength(e)).map(e => e.date)).size;
      const elapsed = i === 0 ? daysBetween(from, today) + 1 : 7;
      return { label: i === 0 ? `This week (${elapsed} of 7 days so far)` : `${i} week${i > 1 ? 's' : ''} ago`, workoutDays, workoutMins, walks, strengthDays, elapsed };
    });

    // ── Garmin daily totals (via Apple Health), completed days only ──
    // Drop watch glitches (same bounds as the app) before averaging
    const BOUNDS = { steps: [1, 100000], active_kcal: [1, 6000], resting_kcal: [800, 4500], sleep_min: [60, 960], resting_hr: [30, 120], hrv_ms: [5, 300], stress_avg: [1, 100], bb_high: [1, 100] };
    const health = (healthRows || []).filter(h => h.date < today).map(h => {
      const c = { ...h };
      for (const [k, [lo, hi]] of Object.entries(BOUNDS)) if (c[k] != null && (c[k] < lo || c[k] > hi)) c[k] = null;
      if (c.active_kcal != null && c.active_kcal === c.resting_kcal) c.active_kcal = null; // wiring mistake
      return c;
    });
    const hAvg = (from, to, f) => { const r = health.filter(h => inRange(h.date, from, to) && h[f]); return r.length ? { v: Math.round(r.reduce((a, h) => a + h[f], 0) / r.length), n: r.length } : null; };
    const yest = addDays(today, -1);
    const garmin = {
      last7:  { active: hAvg(addDays(today, -7), yest, 'active_kcal'), resting: hAvg(addDays(today, -7), yest, 'resting_kcal'), steps: hAvg(addDays(today, -7), yest, 'steps') },
      prior28:{ active: hAvg(addDays(today, -35), addDays(today, -8), 'active_kcal'), steps: hAvg(addDays(today, -35), addDays(today, -8), 'steps') },
      d90:    { active: hAvg(addDays(today, -90), yest, 'active_kcal'), resting: hAvg(addDays(today, -90), yest, 'resting_kcal'), steps: hAvg(addDays(today, -90), yest, 'steps') },
    };
    const total7 = garmin.last7.active && garmin.last7.resting ? garmin.last7.active.v + garmin.last7.resting.v : null;
    const pct = (a, b) => a && b ? `${signed(Math.round((a.v - b.v) / b.v * 100))}%` : 'n/a';
    const garminLines = !health.length ? ['- No Garmin data synced yet'] : [
      `- Last 7 days (avg/day): ${garmin.last7.active?.v ?? '?'} active + ${garmin.last7.resting?.v ?? '?'} resting = ${total7 ?? '?'} kcal burned; ${garmin.last7.steps?.v?.toLocaleString() ?? '?'} steps (plan: 15,000)`,
      `- Previous 4 weeks (avg/day): ${garmin.prior28.active?.v ?? '?'} active, ${garmin.prior28.steps?.v?.toLocaleString() ?? '?'} steps → last 7 days vs that: active ${pct(garmin.last7.active, garmin.prior28.active)}, steps ${pct(garmin.last7.steps, garmin.prior28.steps)}`,
      `- 90-day baseline (avg/day): ${garmin.d90.active?.v ?? '?'} active, ${garmin.d90.resting?.v ?? '?'} resting, ${garmin.d90.steps?.v?.toLocaleString() ?? '?'} steps (${garmin.d90.active?.n ?? 0} days of data)`,
    ];

    // ── Sleep + resting heart rate (recovery) ──
    const sl7 = hAvg(addDays(today, -7), yest, 'sleep_min'), sl28 = hAvg(addDays(today, -28), yest, 'sleep_min');
    const short14 = health.filter(h => h.date >= addDays(today, -14) && h.sleep_min && h.sleep_min < 420).length;
    const n14 = health.filter(h => h.date >= addDays(today, -14) && h.sleep_min).length;
    const hr7 = hAvg(addDays(today, -7), yest, 'resting_hr'), hr28 = hAvg(addDays(today, -35), addDays(today, -8), 'resting_hr');
    const hm = m => `${Math.floor(m / 60)}h ${String(Math.round(m % 60)).padStart(2, '0')}m`;
    const last7Sleep = health.filter(h => h.date >= addDays(today, -7) && h.date <= yest && h.sleep_min).map(h => h.sleep_min);
    const sleepRange = last7Sleep.length >= 3 ? Math.max(...last7Sleep) - Math.min(...last7Sleep) : null;
    const drinks7 = (foodRows || []).filter(r => r.is_drink && r.date >= addDays(today, -6) && r.date <= today).length;
    const recoveryLines = [
      last7Sleep.length >= 3 ? `- Sleep consistency (last 7 nights): shortest ${hm(Math.min(...last7Sleep))}, longest ${hm(Math.max(...last7Sleep))} (a ${hm(sleepRange)} swing); 7h+ on ${last7Sleep.filter(m => m >= 420).length} of ${last7Sleep.length}` : null,
      `- Alcoholic drinks logged: ${drinks7} in the last 7 days`,
      sl7 ? `- Sleep: ${hm(sl7.v)} per night last 7 nights vs ${sl28 ? hm(sl28.v) : 'n/a'} over 28 nights; under 7h on ${short14} of the last ${n14} nights` : '- Sleep: no data synced',
      (() => { // HRV: Garmin's overnight average against their own normal range
        const hv7 = hAvg(addDays(today, -7), yest, 'hrv_ms'), hv28 = hAvg(addDays(today, -35), addDays(today, -8), 'hrv_ms');
        if (!hv7) return null;
        const latest = k => health.filter(h => h[k] && h.date <= yest).sort((x, y) => (x.date < y.date ? 1 : -1))[0]; // newest, regardless of order
        const base = latest('hrv_high');
        const below = health.filter(h => h.date >= addDays(today, -7) && h.date <= yest && h.hrv_ms && base && h.hrv_ms < base.hrv_low).length;
        const st = latest('hrv_status')?.hrv_status;
        return `- HRV (overnight): ${hv7.v} ms last 7 nights vs ${hv28 ? hv28.v + ' ms the 4 weeks before' : 'no baseline yet'}${base ? `; their normal range ${base.hrv_low}-${base.hrv_high} ms, below it on ${below} of the last 7 nights` : ''}${st ? `; Garmin status: ${st}` : ''}`;
      })(),
      (() => { const s7 = hAvg(addDays(today, -7), yest, 'stress_avg'), s28 = hAvg(addDays(today, -35), addDays(today, -8), 'stress_avg'), b7 = hAvg(addDays(today, -7), yest, 'bb_high');
        return s7 || b7 ? `- Garmin stress: ${s7 ? `${s7.v}/100 last 7 days${s28 ? ` vs ${s28.v} before` : ''}` : 'n/a'}; Body Battery morning high: ${b7 ? b7.v + '/100' : 'n/a'}` : null; })(),
      hr7 ? `- Resting heart rate: ${hr7.v} bpm last 7 days vs ${hr28 ? hr28.v + ' bpm the 4 weeks before' : 'no baseline yet'}${hr28 ? ` (${signed(hr7.v - hr28.v)} bpm)` : ''}` : '- Resting heart rate: no data synced',
    ].filter(Boolean);

    // ── Habits ──
    const logs = {};
    (habitLogRows || []).forEach(l => { (logs[l.habit_id] = logs[l.habit_id] || {})[l.date] = l.value || 0; });
    const done = (h, d) => { const v = (logs[h.id] || {})[d] || 0; return h.target_type === 'quantity' ? v >= (h.target_value || 1) : v >= 1; };
    const startOf = h => { const f = Object.keys(logs[h.id] || {}).sort()[0]; const c = h.created_at ? String(h.created_at).slice(0, 10) : null; return [f, c].filter(Boolean).sort()[0] || today; };
    const rateIn = (h, from, to) => {
      const s = startOf(h); let n = 0, k = 0;
      for (let d = from; d <= to; d = addDays(d, 1)) if (d >= s) { n++; if (done(h, d)) k++; }
      return n ? { k, n, pct: Math.round(k / n * 100) } : null;
    };
    const streak = h => { let d = today, s = 0; if (!done(h, d)) d = addDays(d, -1); while (s < 999 && done(h, d)) { s++; d = addDays(d, -1); } return s; };
    const habitLines = (habitsRows || []).map(h => {
      const r7 = rateIn(h, addDays(today, -6), today), r30 = rateIn(h, addDays(today, -29), today), prior = rateIn(h, addDays(today, -59), addDays(today, -30));
      if (!r30) return `- ${h.name}: not started yet`;
      const trend = prior ? (r30.pct - prior.pct >= 10 ? 'improving' : prior.pct - r30.pct >= 10 ? 'slipping' : 'steady') + ` vs the 30 days before (${prior.pct}%)` : 'no earlier data';
      const auto = h.auto_source === 'strava' ? ' [auto-completed from Strava workouts]' : '';
      return `- ${h.name}${auto}: last 7 days ${r7 ? `${r7.k}/${r7.n}` : '—'}, last 30 days ${r30.pct}% — ${trend}. Current streak ${streak(h)} days.`;
    });

    // ── Food (averages over LOGGED days only) ──
    const byDate = {};
    (foodRows || []).filter(r => r.date <= today).forEach(r => { (byDate[r.date] = byDate[r.date] || []).push(r); });
    const foodWindow = n => {
      const ds = Object.keys(byDate).filter(d => d >= addDays(today, -(n - 1)));
      if (!ds.length) return { days: 0 };
      const t = sumMacros(ds.flatMap(d => byDate[d]));
      return { days: ds.length, cal: Math.round(t.cal / ds.length), pro: Math.round(t.pro / ds.length), carb: Math.round(t.carb / ds.length), fat: Math.round(t.fat / ds.length), sug: Math.round(t.sug / ds.length), drinks: ds.flatMap(d => byDate[d]).filter(r => r.is_drink).length };
    };
    const f7 = foodWindow(7), f30 = foodWindow(30);
    const vsGoal = (v, goal, unit) => goal ? `${v}${unit}/day (target ${goal}${unit}, ${signed(v - goal)})` : `${v}${unit}/day`;

    // ── What the logged days actually show (last 14 days; 30 if fewer than 3) ──
    // A day with under half the calorie target logged is treated as PARTIAL:
    // still useful for meals and food choices, but not for daily adherence.
    const qMap = {}; (Array.isArray(input.foods_quality) ? input.foods_quality : []).slice(0, 60)
      .forEach(q => { if (q && q.name) qMap[String(q.name).toLowerCase().trim()] = q; });
    let detailDays = Object.keys(byDate).filter(d => d >= addDays(today, -13)).sort();
    let detailSpan = 14;
    if (detailDays.length < 3) { detailDays = Object.keys(byDate).filter(d => d >= addDays(today, -29)).sort(); detailSpan = 30; }
    const dayTotals = detailDays.map(d => ({ d, ...sumMacros(byDate[d]), meals: new Set(byDate[d].map(r => r.meal || 'other')).size }));
    const full = dayTotals.filter(t => goals.cal ? t.cal >= goals.cal * 0.5 : t.meals >= 2);
    const foodLines = [];
    if (detailDays.length) {
      foodLines.push(`- Logged ${detailDays.length} day${detailDays.length === 1 ? '' : 's'} in the last ${detailSpan} (${full.length} full day${full.length === 1 ? '' : 's'}, ${detailDays.length - full.length} partial). Unlogged days are UNKNOWN, not zero.`);
      if (full.length) {
        const proHit = goals.pro ? full.filter(t => t.pro >= goals.pro * 0.9).length : null;
        const calIn = goals.cal ? full.filter(t => Math.abs(t.cal - goals.cal) <= goals.cal * 0.1).length : null;
        const calOver = goals.cal ? full.filter(t => t.cal > goals.cal * 1.1).length : null;
        const avg = k => Math.round(full.reduce((a, t) => a + (t[k] || 0), 0) / full.length);
        foodLines.push(`- Full days: calories ${vsGoal(avg('cal'), goals.cal, '')}; within ±10% of target on ${calIn}/${full.length}, over on ${calOver}/${full.length}`);
        foodLines.push(`- Full days: protein ${vsGoal(avg('pro'), goals.pro, 'g')}; hit 90%+ of target on ${proHit}/${full.length}`);
        const lim = [goals.sug ? `sugar ${avg('sug')}g (limit ${goals.sug}g)` : null, goals.sod ? `sodium ${avg('sod').toLocaleString()}mg (limit ${goals.sod.toLocaleString()}mg)` : null,
          goals.fib ? `fiber ${avg('fib')}g (goal ${goals.fib}g)` : null, goals.satFat ? `saturated fat ${avg('sat')}g (limit ${goals.satFat}g)` : null].filter(Boolean);
        if (lim.length) foodLines.push(`- Full days: ${lim.join(', ')}`);
      }
      // Meals: average per logged day that had that meal
      const mealStats = {};
      detailDays.forEach(d => byDate[d].forEach(r => { const m = r.meal || 'other'; (mealStats[m] = mealStats[m] || { days: new Set(), cal: 0, pro: 0 }); mealStats[m].days.add(d); mealStats[m].cal += r.cal || 0; mealStats[m].pro += r.pro || 0; }));
      const order = ['breakfast', 'lunch', 'dinner', 'snacks', 'uncategorized', 'other'];
      foodLines.push('- By meal (avg when logged): ' + Object.entries(mealStats).sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
        .map(([m, v]) => `${m} ${Math.round(v.cal / v.days.size)} kcal / ${Math.round(v.pro / v.days.size)}g protein (${v.days.size} day${v.days.size === 1 ? '' : 's'})`).join('; '));
      // Foods
      const agg = {};
      detailDays.forEach(d => byDate[d].forEach(r => { const k = String(r.name || '').toLowerCase().trim(); if (!k) return;
        (agg[k] = agg[k] || { name: r.name, n: 0, cal: 0, pro: 0, sug: 0, sod: 0 }); agg[k].n++; agg[k].cal += r.cal || 0; agg[k].pro += r.pro || 0; agg[k].sug += r.sug || 0; agg[k].sod += r.sod || 0; }));
      const all = Object.values(agg), totCal = all.reduce((a, f) => a + f.cal, 0) || 1, totPro = all.reduce((a, f) => a + f.pro, 0) || 1;
      const sc = f => { const q = qMap[f.name.toLowerCase().trim()]; return q && q.score != null ? ` [quality ${q.score}${q.nova === 4 ? ', ultra-processed' : q.nova === 1 ? ', whole food' : ''}]` : ''; };
      const fmt = f => `${f.name} (${f.n}x, ~${Math.round(f.cal / f.n)} kcal / ${Math.round(f.pro / f.n)}g protein each)${sc(f)}`;
      foodLines.push('- Most frequent: ' + [...all].sort((a, b) => b.n - a.n || b.cal - a.cal).slice(0, 6).map(fmt).join('; '));
      foodLines.push('- Biggest calorie sources: ' + [...all].sort((a, b) => b.cal - a.cal).slice(0, 3).map(f => `${f.name} ${Math.round(f.cal / totCal * 100)}% of logged calories${sc(f)}`).join('; '));
      foodLines.push('- Biggest protein sources: ' + [...all].sort((a, b) => b.pro - a.pro).slice(0, 3).map(f => `${f.name} ${Math.round(f.pro / totPro * 100)}% of logged protein`).join('; '));
      const scored = all.filter(f => qMap[f.name.toLowerCase().trim()]?.score != null).sort((a, b) => qMap[a.name.toLowerCase().trim()].score - qMap[b.name.toLowerCase().trim()].score);
      if (scored.length >= 2) foodLines.push(`- Lowest quality: ${scored.slice(0, 2).map(f => `${f.name} (${qMap[f.name.toLowerCase().trim()].score})`).join(', ')}; highest: ${scored.slice(-2).reverse().map(f => `${f.name} (${qMap[f.name.toLowerCase().trim()].score})`).join(', ')}`);
    } else foodLines.push('- No food logged in the last 30 days');

    // ── Prompt ──
    const systemPrompt = `You are this person's coach for nutrition, training and recovery together, writing their weekly check-in. Write like a good coach texting a client: specific, encouraging where it's earned, direct about what to change, never preachy.

THINK IN FOUR PILLARS, AND HOW THEY CONNECT:
- BODY: the weight trend against the plan.
- TRAINING: sessions against plan (especially strength training), minutes, steps against the 15k goal.
- NUTRITION: calories and protein on logged days, how meals are built, food quality.
- RECOVERY: sleep amount and consistency, HRV against their normal range, resting heart rate, stress and Body Battery, alcohol.
The scale is one signal, not the verdict. Look for the connections a good coach would:
- Short or erratic sleep drives hunger and cravings, weaker sessions and a noisier scale. When it lines up with overeating or a stall, sleep is the lever, ahead of cutting calories.
- Resting heart rate up 5+ bpm, or HRV below their normal range on several nights (or a falling HRV trend), while training hard in a deficit means under-recovery: ease the deficit or the load, don't push harder. HRV is the more sensitive signal; one low night means little, a run of them matters.
- High Garmin stress or a low Body Battery morning high alongside short sleep is the same story: recovery is the lever.
- Strength training on plan + protein at or near target + the scale moving slower than planned: muscle may be partly offsetting fat loss. Say "possibly" and suggest a weekly waist measurement (or photos) to confirm. Never use this to excuse a stall when logged intake is over target or training is off plan.
- Alcohol worsens sleep and appetite the following day.
- Steps are a large, easy share of their daily burn; a drop shows up on the scale.

STRUCTURE (plain text, rendered as-is; no markdown, no #, **, *, -, or numbered lists):
Paragraph 1, WINS: one or two specific things that went well, from any pillar, with numbers. If little went well, find the most genuine positive; don't invent one.
Paragraph 2, BIG PICTURE: an honest read of the week across the four pillars in plain language: where the body trend is against the plan, a one-line recovery read (always include it), training consistency, and how they connect. Name the ONE pillar that is the biggest lever right now.
Paragraph 3, FOOD: what their logged food shows: which meals carry protein and which are light, which foods drive calories, one concrete swap or addition using foods they already eat.
Paragraph 4, THIS WEEK: one or two specific, measurable actions from whichever pillar is the biggest lever (sleep, training, food or steps). Then stop.
260-340 words. Finish every sentence. Write numbers over 999 with commas (2,298 kcal).

HOW TO READ THE DATA:
- Every number below is pre-computed. Quote them; never do your own arithmetic or invent numbers.
- Work with what they DID log. Unlogged days are unknown, not zero. Partial days count for meals and food choices, not daily totals.
- Never open with logging gaps or missing notes, and don't scold. Mention logging at most once, as the final sentence, and only when a target change depends on it, framed forward ("A full week of logs would let me fine-tune your target").
- If they wrote notes, respond to them specifically without repeating them back.
- Trust weekly rates and 7-day averages over single weigh-ins.
- An outdoor walk is not a workout; walks support the step goal.

CALORIES (critical):
- The daily target ALREADY includes their activity (Garmin: measured average burn minus the planned deficit). Never add exercise calories on top, never compute a "true deficit", never suggest eating back exercise calories. Garmin numbers are estimates.

TARGET ADJUSTMENTS:
- Only consider a change when the 28-day pace misses the plan by more than 0.25 lb/week (see "Pace gap"), AND there are at least 5 full logged days in the window.
- Fix recovery first: if sleep is short, HRV is below normal on most nights, or resting heart rate is up, don't lower the target that week.
- If full logged days are mostly OVER target, the fix is adherence, not a lower number.
- If full logged days are well UNDER target but the scale isn't moving, the likely explanation is food that isn't making it into the log (oils, sauces, snacks, drinks, weekends). Say so once, kindly, as a hypothesis, and don't lower the target.
- If adherence, training and recovery look good and loss is too slow, recommend lowering by 100-150 kcal; if faster than planned, raising by 100-150. Give the exact new number. Otherwise hold the target and don't dwell on it.

FOOD QUALITY: Use the per-food quality scores to pick swaps (75+ excellent, 50-74 good, 25-49 poor, under 25 bad). Never call ultra-processed food "fine"; if processing is unknown, don't draw conclusions about it.

Never suggest cutting training volume as a way to lose weight.`;

    const dataBlock = `TODAY: ${today}

PROFILE & PLAN
- ${settings.sex || 'male'}, ${settings.age || '?'}, ${settings.heightFt || '?'}'${settings.heightIn || 0}"
- Goal: ${goal === 'cut' ? `lose fat at ${rate} lb/week while keeping or building muscle (they strength train)` : goal === 'bulk' ? `gain muscle at ${rate} lb/week while limiting fat gain` : 'maintain weight while improving body composition and fitness'}
- Daily targets: ${goals.cal || '?'} kcal, ${goals.pro || '?'}g protein, ${goals.carb || '?'}g carbs, ${goals.fat || '?'}g fat
- Calorie target source: ${target.source === 'garmin' ? `Garmin — measured burn ${target.tdee} kcal/day (avg of ${target.days} recent days) minus deficit` : 'estimate from activity level (not enough Garmin data yet)'}
- Training plan: ${plannedSessions} workouts per week plus 15k steps/day

WEIGHT
- Latest: ${latest ? `${latest.lbs} lbs on ${latest.date}${daysBetween(latest.date, today) > 3 ? ` (${daysBetween(latest.date, today)} days ago — weigh-ins have lapsed)` : ''}` : 'no weigh-ins'}
- 7-day average: ${avg7 ?? 'n/a'}${avgPrev7 != null && avg7 != null ? ` vs ${avgPrev7} the week before (${signed(round1(avg7 - avgPrev7))} lbs)` : ''}
- Pace over the last 28 days (${n28} weigh-ins): ${paceLabel}
- Pace gap vs plan: ${paceGap == null ? 'n/a (need 6+ weigh-ins in 28 days)' : `${signed(paceGap)} lb/wk (${Math.abs(paceGap) > 0.25 ? 'beyond' : 'within'} the 0.25 adjustment threshold)`}
- 90-day change: ${latest && w90 ? `${signed(round1(latest.lbs - w90.lbs))} lbs since ${w90.date}` : 'n/a'}

ACTIVITY (workout days per week vs plan of ${plannedSessions}; outdoor walks counted separately)
${weeks.map(w => `- ${w.label}: ${w.workoutDays} workout day${w.workoutDays === 1 ? '' : 's'} (${w.strengthDays} with strength training)${w.workoutMins ? `, ${w.workoutMins} min total` : ''}, ${w.walks} outdoor walk${w.walks === 1 ? '' : 's'}`).join('\n')}

GARMIN DAILY BURN & STEPS (completed days only)
${garminLines.join('\n')}

RECOVERY (Garmin)
${recoveryLines.join('\n')}

FOOD QUALITY (Lōg score 0-100, calorie-weighted; from logged foods over the last 7 days)
${fq && fq.days ? `- Average ${Math.round(fq.score)}/100 over ${fq.days} logged day${fq.days === 1 ? '' : 's'}${fq.upfPct != null && fq.coverage >= 0.5 ? `; ${fq.upfPct}% of calories from ultra-processed foods` : `; processing unknown (ingredient data for only ${Math.round((fq.coverage || 0) * 100)}% of calories, too little to judge)`}` : '- Not enough logged food to judge'}

HABITS
${habitLines.length ? habitLines.join('\n') : '- No habits set up'}

WHAT THEY ATE
${foodLines.join('\n')}
- Drinks logged (last 30 days): ${f30.drinks || 0}

USER'S NOTES ON HOW THINGS ARE GOING
${notes ? notes : '(none provided)'}

Write the check-in now.`.replace(/\n{3,}/g, '\n\n');

    // ── Call Claude (newest model first, older one as a fallback) ──
    let aData = null, lastErr = '';
    for (const model of MODELS) {
      const aRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, max_tokens: 2000, system: systemPrompt, messages: [{ role: 'user', content: dataBlock }] }),
      });
      if (aRes.ok) { aData = await aRes.json(); aData._model = model; break; }
      lastErr = `${aRes.status}: ${(await aRes.text()).slice(0, 200)}`;
      if (![400, 404].includes(aRes.status)) break; // only fall back when the model itself is unavailable
    }
    if (!aData) return json(500, { error: `Claude API error ${lastErr}` });
    let message = (aData.content || []).map(b => b.text || '').join('').trim();
    // If it still ran out of room, end at the last complete sentence rather than mid-thought
    if (aData.stop_reason === 'max_tokens') {
      const cut = Math.max(message.lastIndexOf('. '), message.lastIndexOf('.\n'), message.lastIndexOf('! '), message.lastIndexOf('? '));
      if (cut > message.length * 0.5) message = message.slice(0, cut + 1).trim();
    }

    return json(200, {
      message,
      generated_at: new Date().toISOString(),
      model: aData._model,
      data_summary: { current_weight: latest?.lbs ?? null, rate_28d: rate28, workout_days_this_week: weeks[0].workoutDays, food_days_30d: f30.days },
      tokens: { in: aData.usage?.input_tokens, out: aData.usage?.output_tokens },
    });
  } catch (e) {
    return json(500, { error: e.message || 'Internal error' });
  }
};
