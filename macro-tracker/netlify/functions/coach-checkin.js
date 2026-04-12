// netlify/functions/coach-checkin.js
//
// GET /api/coach-checkin?profile_id=X
//
// Aggregates the user's recent nutrition, weight, exercise, drink, and habit
// data from Supabase, builds a structured prompt, and calls Claude Haiku for
// an analytical coaching response.
//
// Returns: { message, generated_at, data_summary }

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const json = (statusCode, body) => ({ statusCode, headers, body: JSON.stringify(body) });

async function sb(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

// Sum macros across an array of food log rows
function sumMacros(rows) {
  return rows.reduce((acc, r) => ({
    cal:    acc.cal    + (r.cal    || 0),
    pro:    acc.pro    + (r.pro    || 0),
    carb:   acc.carb   + (r.carb   || 0),
    fat:    acc.fat    + (r.fat    || 0),
    satFat: acc.satFat + (r.sat_fat || 0),
    sug:    acc.sug    + (r.sug    || 0),
    sod:    acc.sod    + (r.sod    || 0),
    fib:    acc.fib    + (r.fib    || 0),
  }), { cal:0, pro:0, carb:0, fat:0, satFat:0, sug:0, sod:0, fib:0 });
}

// Group food rows by date and return per-date totals
function groupByDate(rows) {
  const byDate = {};
  rows.forEach(r => {
    if (!byDate[r.date]) byDate[r.date] = [];
    byDate[r.date].push(r);
  });
  return byDate;
}

// Average per-day across a window of dates
function avgPerDay(rowsByDate, windowDays) {
  const dates = Object.keys(rowsByDate);
  if (!dates.length) return null;
  const totals = sumMacros(dates.flatMap(d => rowsByDate[d]));
  const days = Math.max(1, windowDays || dates.length);
  return {
    cal:    Math.round(totals.cal    / days),
    pro:    Math.round(totals.pro    / days),
    carb:   Math.round(totals.carb   / days),
    fat:    Math.round(totals.fat    / days),
    satFat: Math.round(totals.satFat / days),
    sug:    Math.round(totals.sug    / days),
    sod:    Math.round(totals.sod    / days),
    fib:    Math.round(totals.fib    / days),
    daysLogged: dates.length,
  };
}

// Filter dates within the last N days from today (UTC date strings)
function filterRecentDays(rowsByDate, n) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - n);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const out = {};
  Object.entries(rowsByDate).forEach(([d, rows]) => {
    if (d >= cutoffStr) out[d] = rows;
  });
  return out;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method not allowed' });

  if (!SUPABASE_URL || !SUPABASE_KEY || !ANTHROPIC_KEY) {
    return json(500, { error: 'env vars not configured' });
  }

  const profile_id = event.queryStringParameters?.profile_id;
  if (!profile_id) return json(400, { error: 'profile_id required' });

  try {
    // ── Fetch all the data we need in parallel ────────────────────
    // Each fetch is wrapped to return [] on failure so a single missing table
    // doesn't kill the whole analysis. The frontend gets a working response
    // with whatever data is available.
    const safeSb = (path) => sb(path).catch(e => { console.warn('[coach] fetch failed:', path, e.message); return []; });
    const [foodRows, weightRows, exerciseRows, settingsRows, habitsRows, habitLogsRows] = await Promise.all([
      safeSb(`food_logs?profile_id=eq.${encodeURIComponent(profile_id)}&order=date.asc&limit=1000000`),
      safeSb(`weights?profile_id=eq.${encodeURIComponent(profile_id)}&order=date.asc&limit=1000000`),
      safeSb(`exercise_logs?profile_id=eq.${encodeURIComponent(profile_id)}&order=date.asc&limit=1000000`),
      safeSb(`settings?profile_id=eq.${encodeURIComponent(profile_id)}`),
      safeSb(`habits?profile_id=eq.${encodeURIComponent(profile_id)}`),
      safeSb(`habit_logs?profile_id=eq.${encodeURIComponent(profile_id)}&order=date.asc&limit=1000000`),
    ]);

    // ── Aggregate ──────────────────────────────────────────────────
    const foodByDate = groupByDate(foodRows || []);
    const week = filterRecentDays(foodByDate, 7);
    const month = filterRecentDays(foodByDate, 30);
    const ninety = filterRecentDays(foodByDate, 90);

    const weekAvg  = avgPerDay(week,  7);
    const monthAvg = avgPerDay(month, 30);
    const ninetyAvg= avgPerDay(ninety, 90);

    // Drinks per period — drinks are food rows with is_drink=true
    const drinksWeek  = (foodRows || []).filter(r => r.is_drink && week[r.date]).length;
    const drinksMonth = (foodRows || []).filter(r => r.is_drink && month[r.date]).length;

    // Weight trajectory
    const sortedWeights = (weightRows || []).filter(w => w.weight).map(w => ({ date: w.date, lbs: parseFloat(w.weight) }));
    const currentWeight = sortedWeights.length ? sortedWeights[sortedWeights.length - 1].lbs : null;
    const weight7d  = sortedWeights.find(w => {
      const d = new Date(); d.setDate(d.getDate() - 7);
      return w.date >= d.toISOString().slice(0,10);
    });
    const weight30d = sortedWeights.find(w => {
      const d = new Date(); d.setDate(d.getDate() - 30);
      return w.date >= d.toISOString().slice(0,10);
    });
    const weight90d = sortedWeights.find(w => {
      const d = new Date(); d.setDate(d.getDate() - 90);
      return w.date >= d.toISOString().slice(0,10);
    });
    const delta7  = (currentWeight && weight7d)  ? +(currentWeight - weight7d.lbs).toFixed(1)  : null;
    const delta30 = (currentWeight && weight30d) ? +(currentWeight - weight30d.lbs).toFixed(1) : null;
    const delta90 = (currentWeight && weight90d) ? +(currentWeight - weight90d.lbs).toFixed(1) : null;

    // Exercise — last 7 / 30 days
    const exer7 = (exerciseRows || []).filter(e => {
      const d = new Date(); d.setDate(d.getDate() - 7);
      return e.date >= d.toISOString().slice(0,10);
    });
    const exer30 = (exerciseRows || []).filter(e => {
      const d = new Date(); d.setDate(d.getDate() - 30);
      return e.date >= d.toISOString().slice(0,10);
    });
    const exer7Cal  = exer7.reduce((a,e)  => a + (e.calories_burned || 0), 0);
    const exer30Cal = exer30.reduce((a,e) => a + (e.calories_burned || 0), 0);

    // Habits — completion rate over last 7 days
    const habitMap = {};
    (habitsRows || []).forEach(h => { habitMap[h.id] = h; });
    const habitWindow = (() => {
      const days = [];
      for (let i = 0; i < 7; i++) {
        const d = new Date(); d.setDate(d.getDate() - i);
        days.push(d.toISOString().slice(0,10));
      }
      return days;
    })();
    const habitStats = (habitsRows || []).map(h => {
      const logs = (habitLogsRows || []).filter(l => l.habit_id === h.id && habitWindow.includes(l.date));
      const completed = logs.filter(l => {
        if (h.target_type === 'quantity') return (l.value || 0) >= (h.target_value || 1);
        return (l.value || 0) >= 1;
      }).length;
      return { name: h.name, completed, total: 7 };
    });

    // Profile settings — stored as a JSONB `data` blob keyed off profile_id.
    // Goals (cal/pro/carb/fat targets) are NOT stored in the settings table —
    // the frontend computes them on the fly via Mifflin-St Jeor and passes
    // them in as query params so we don't have to duplicate the math.
    const settingsRow = (settingsRows && settingsRows[0]) || {};
    const settings = settingsRow.data || {};
    const qsGoals = event.queryStringParameters || {};
    const goals = {
      cal:  parseInt(qsGoals.cal)  || null,
      pro:  parseInt(qsGoals.pro)  || null,
      carb: parseInt(qsGoals.carb) || null,
      fat:  parseInt(qsGoals.fat)  || null,
    };

    // ── Build the prompt ───────────────────────────────────────────
    const systemPrompt = `You are an analytical nutrition and fitness coach. You review the user's tracked data and give specific, evidence-based feedback. Follow these rules strictly and without exception:

FORMATTING RULES (CRITICAL):
- Never use markdown syntax. No #, ##, ###, **, *, _, -, or numbered lists. The output is rendered as plain text.
- Write in clean paragraphs separated by blank lines. 3-4 paragraphs maximum.
- No bullet points. No section headers. No bold text. Just prose.
- Aim for 180-220 words total. Be selective; do not pad.

CONTENT RULES:
- The data block below contains pre-computed numbers and percentages. Use them directly. NEVER derive your own percentages or do arithmetic — the math is already done for you.
- Always cite specific numbers from the data.
- Identify what is working AND what needs attention. Be proportional — don't over-praise or over-criticize.
- Be realistic about isolated events. One drink in a week is not a problem. A pattern is.
- Never suggest cutting training volume. Assume the schedule is intentional.
- Don't moralize. Don't lecture. State facts, identify trends, suggest one specific action.
- End with one specific actionable recommendation.`;

    // Pre-compute all percentages and deltas so the model never has to do arithmetic.
    const pct = (actual, target) => target ? Math.round((actual / target) * 100) : null;
    const delta = (actual, target) => target ? actual - target : null;
    const fmtDelta = (d) => d === null ? '?' : (d > 0 ? '+' : '') + d;
    const fmtPct = (p) => p === null ? '?' : p + '%';

    const w = weekAvg;
    const m = monthAvg;
    const n = ninetyAvg;

    const dataBlock = `
USER PROFILE:
- ${settings.sex || 'M'}, ${settings.age || '?'}, ${settings.heightFt || '?'}'${settings.heightIn || 0}", currently ${currentWeight || '?'} lbs
- Goal: ${settings.goal || 'cut'} at ${settings.rate || '1'} lb/week
- Daily targets: ${goals.cal || '?'} cal / ${goals.pro || '?'}g protein / ${goals.carb || '?'}g carbs / ${goals.fat || '?'}g fat
- Activity level: ${settings.activity || '?'}, training split: ${settings.split || '?'}

LAST 7 DAYS (pre-computed — use these numbers directly, do NOT recalculate):
${w ? `- Days logged: ${w.daysLogged} of 7
- Calories: ${w.cal}/day average. Target ${goals.cal || '?'}. ${fmtPct(pct(w.cal, goals.cal))} of target. Delta ${fmtDelta(delta(w.cal, goals.cal))} kcal/day.
- Protein: ${w.pro}g/day average. Target ${goals.pro || '?'}g. ${fmtPct(pct(w.pro, goals.pro))} of target. Delta ${fmtDelta(delta(w.pro, goals.pro))}g/day.
- Carbs: ${w.carb}g/day average. ${fmtPct(pct(w.carb, goals.carb))} of ${goals.carb || '?'}g target. Delta ${fmtDelta(delta(w.carb, goals.carb))}g.
- Fat: ${w.fat}g/day average. ${fmtPct(pct(w.fat, goals.fat))} of ${goals.fat || '?'}g target. Delta ${fmtDelta(delta(w.fat, goals.fat))}g.
- Sugar: ${w.sug}g/day average.
- Drinks logged: ${drinksWeek}
- Exercise: ${exer7.length} sessions, ${exer7Cal} kcal burned total
- Weight delta: ${delta7 !== null ? (delta7 > 0 ? '+' : '') + delta7 + ' lbs' : 'no data'}` : '- No data this week'}

LAST 30 DAYS (pre-computed):
${m ? `- Days logged: ${m.daysLogged} of 30 (${Math.round(m.daysLogged/30*100)}% adherence)
- Calories: ${m.cal}/day average. ${fmtPct(pct(m.cal, goals.cal))} of ${goals.cal || '?'} target. Delta ${fmtDelta(delta(m.cal, goals.cal))} kcal/day.
- Protein: ${m.pro}g/day. ${fmtPct(pct(m.pro, goals.pro))} of ${goals.pro || '?'}g target. Delta ${fmtDelta(delta(m.pro, goals.pro))}g/day.
- Carbs: ${m.carb}g/day, Fat: ${m.fat}g/day
- Drinks: ${drinksMonth} total (${(drinksMonth/4.3).toFixed(1)}/week)
- Exercise: ${exer30.length} sessions, ${exer30Cal} kcal burned total
- Weight delta: ${delta30 !== null ? (delta30 > 0 ? '+' : '') + delta30 + ' lbs' : 'no data'}
- Implied rate: ${delta30 !== null ? (delta30 / 4.3).toFixed(2) + ' lbs/week' : '?'}` : '- No data this month'}

LAST 90 DAYS (pre-computed):
${n ? `- Days logged: ${n.daysLogged} of 90 (${Math.round(n.daysLogged/90*100)}% adherence)
- Calories: ${n.cal}/day average. ${fmtPct(pct(n.cal, goals.cal))} of target.
- Protein: ${n.pro}g/day. ${fmtPct(pct(n.pro, goals.pro))} of target.
- Weight delta: ${delta90 !== null ? (delta90 > 0 ? '+' : '') + delta90 + ' lbs' : 'no data'}` : '- Limited 90-day data'}

HABITS (last 7 days):
${habitStats.length ? habitStats.map(h => `- ${h.name}: ${h.completed} of 7 days`).join('\n') : '- No habits tracked'}

Write your analysis now. Use the pre-computed numbers above directly. Do NOT do any arithmetic. Plain text only — no markdown, no headers, no bullets. 3-4 paragraphs, 180-220 words.`;

    // ── Call Claude ────────────────────────────────────────────────
    const aRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 800,
        system: systemPrompt,
        messages: [{ role: 'user', content: dataBlock }],
      }),
    });

    if (!aRes.ok) {
      const errText = await aRes.text();
      return json(500, { error: `Claude API error ${aRes.status}`, detail: errText.slice(0, 300) });
    }

    const aData = await aRes.json();
    const message = (aData.content || []).map(b => b.text || '').join('').trim();

    return json(200, {
      message,
      generated_at: new Date().toISOString(),
      data_summary: {
        days_logged_week: weekAvg?.daysLogged || 0,
        days_logged_month: monthAvg?.daysLogged || 0,
        current_weight: currentWeight,
        delta_30d: delta30,
      },
      tokens: { in: aData.usage?.input_tokens, out: aData.usage?.output_tokens },
    });
  } catch (e) {
    return json(500, { error: e.message || 'Internal error' });
  }
};
