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
  }), { cal: 0, pro: 0, carb: 0, fat: 0, sug: 0 });
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
      const elapsed = i === 0 ? daysBetween(from, today) + 1 : 7;
      return { label: i === 0 ? `This week (${elapsed} of 7 days so far)` : `${i} week${i > 1 ? 's' : ''} ago`, workoutDays, workoutMins, walks, elapsed };
    });

    // ── Garmin daily totals (via Apple Health), completed days only ──
    // Drop watch glitches (same bounds as the app) before averaging
    const BOUNDS = { steps: [1, 100000], active_kcal: [1, 6000], resting_kcal: [800, 4500] };
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
    const sparse = f30.days < 10;
    const vsGoal = (v, goal, unit) => goal ? `${v}${unit}/day (target ${goal}${unit}, ${signed(v - goal)})` : `${v}${unit}/day`;

    // ── Prompt ──
    const systemPrompt = `You are a direct, practical fitness coach reviewing one person's tracked data. Your job is to tell them where they are relative to their plan, what is driving it, and the single most useful thing to do this week.

FORMAT (plain text, rendered as-is):
- No markdown at all: no #, **, *, _, -, or numbered lists. No headers.
- 3 or 4 short paragraphs separated by blank lines, 200-260 words total.

HOW TO READ THE DATA:
- Every number below is pre-computed. Quote them; never do your own arithmetic or invent numbers.
- Weight is the ground truth for whether the plan is working. Lead with the weight pace vs plan.
- Weigh-ins fluctuate day to day; trust the weekly rate and 7-day averages over single readings.
- If food logging is marked SPARSE, do not judge intake from the food numbers. Rely on the weight trend and the user's own notes for what they are eating.
- The user's notes describe how things have actually been going. Take them seriously and respond to them specifically, without repeating them back verbatim.
- An outdoor walk is not a workout here; walks support the daily step goal.

CALORIES (critical):
- The daily calorie target ALREADY includes their activity. When its source is "Garmin", it is their measured 7-day average burn (resting + active) minus the planned deficit. Never add exercise or workout calories on top of it, never compute a separate "true deficit", never suggest eating back exercise calories.
- Garmin burn numbers are estimates; the weight trend is the ground truth. Don't claim to know their intake when food logging is sparse.

TARGET ADJUSTMENTS (how a good coach does it):
- The app holds the calorie target steady (4-week Garmin average, refreshed weekly). You decide whether it should change, based on the weight trend.
- Only consider a change when the 28-day pace misses the plan by more than 0.25 lb/week (see "Pace gap").
- Check adherence FIRST. If food logs are sparse, use the user's notes. If they describe eating over target, the fix is adherence, not a lower number: say that plainly and don't lower the target.
- If adherence looks good and loss is too slow, recommend lowering the target by 100-150 kcal. If loss is faster than planned, recommend raising it by 100-150. Give the exact new number.
- If there aren't enough weigh-ins, ask for more consistent weigh-ins before any change.
- Use the 90-day Garmin baseline to judge whether recent activity is normal for them, and say so plainly when it has dropped.

TONE:
- Honest and proportional. Name what is working and what is not. No lecturing or moralizing, no hype.
- Never suggest cutting training volume.
- End with ONE specific, realistic action for the next 7 days, tied to the biggest gap in the data.`;

    const dataBlock = `TODAY: ${today}

PROFILE & PLAN
- ${settings.sex || 'male'}, ${settings.age || '?'}, ${settings.heightFt || '?'}'${settings.heightIn || 0}"
- Goal: ${goal}${goal !== 'maintain' ? ` at ${rate} lb/week` : ''}
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
${weeks.map(w => `- ${w.label}: ${w.workoutDays} workout day${w.workoutDays === 1 ? '' : 's'}${w.workoutMins ? ` (${w.workoutMins} min)` : ''}, ${w.walks} outdoor walk${w.walks === 1 ? '' : 's'}`).join('\n')}

GARMIN DAILY BURN & STEPS (completed days only)
${garminLines.join('\n')}

HABITS
${habitLines.length ? habitLines.join('\n') : '- No habits set up'}

FOOD LOGGING${sparse ? ' — SPARSE' : ''}
- Days logged: ${f7.days} of the last 7, ${f30.days} of the last 30${sparse ? ' (too few to judge intake)' : ''}
${!sparse && f7.days ? `- Last 7 logged days: calories ${vsGoal(f7.cal, goals.cal, '')}, protein ${vsGoal(f7.pro, goals.pro, 'g')}, carbs ${f7.carb}g, fat ${f7.fat}g, sugar ${f7.sug}g` : ''}
${!sparse && f30.days ? `- Last 30 (${f30.days} logged days): calories ${vsGoal(f30.cal, goals.cal, '')}, protein ${vsGoal(f30.pro, goals.pro, 'g')}; drinks logged: ${f30.drinks}` : ''}

USER'S NOTES ON HOW THINGS ARE GOING
${notes ? notes : '(none provided)'}

Write the check-in now.`.replace(/\n{3,}/g, '\n\n');

    // ── Call Claude (newest model first, older one as a fallback) ──
    let aData = null, lastErr = '';
    for (const model of MODELS) {
      const aRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, max_tokens: 900, system: systemPrompt, messages: [{ role: 'user', content: dataBlock }] }),
      });
      if (aRes.ok) { aData = await aRes.json(); aData._model = model; break; }
      lastErr = `${aRes.status}: ${(await aRes.text()).slice(0, 200)}`;
      if (![400, 404].includes(aRes.status)) break; // only fall back when the model itself is unavailable
    }
    if (!aData) return json(500, { error: `Claude API error ${lastErr}` });
    const message = (aData.content || []).map(b => b.text || '').join('').trim();

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
