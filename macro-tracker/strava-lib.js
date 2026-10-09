// netlify/functions/strava-lib.js
//
// Shared helpers for the Strava functions (not an endpoint — no handler).
//   • Supabase REST helper and token refresh
//   • isWorkoutType() + 15-min daily total: the rule for auto-completing habits
//   • applyStravaHabits(): ticks every habit with auto_source = 'strava'

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const STRAVA_CLIENT_ID = process.env.STRAVA_CLIENT_ID;
const STRAVA_CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET;

async function sb(path, init = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const e = new Error(data?.message || `Supabase ${res.status}: ${text}`);
    e.status = res.status; throw e;
  }
  return data;
}

// Returns a valid access token for the token row, refreshing it if it's
// within a minute of expiring.
async function getAccessToken(row) {
  const now = Math.floor(Date.now() / 1000);
  if (now < (row.expires_at || 0) - 60) return row.access_token;
  const res = await fetch('https://www.strava.com/api/v3/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: STRAVA_CLIENT_ID,
      client_secret: STRAVA_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: row.refresh_token,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || 'Token refresh failed');
  await sb(`strava_tokens?profile_id=eq.${encodeURIComponent(row.profile_id)}`, {
    method: 'PATCH',
    body: JSON.stringify({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: data.expires_at,
      created_at: new Date().toISOString(),
    }),
  });
  return data.access_token;
}

// ── The workout rule ────────────────────────────────────────────────
// Any Strava activity is a workout EXCEPT an outdoor walk or hike; treadmill
// walks (trainer = true) do count. A DAY qualifies when its workouts add up to
// 15+ minutes in total — so several short gym recordings (e.g. 3 × 8 min)
// count together, while one accidental 2-minute recording doesn't.
const OUTDOOR_WALK_TYPES = new Set(['Walk', 'Hike']);
const MIN_DAILY_WORKOUT_SECONDS = 15 * 60;

function isWorkoutType(a) {
  const type = a.sport_type || a.type || '';
  return !(OUTDOOR_WALK_TYPES.has(type) && !a.trainer);
}

// Strava activity → exercise_logs row
function toExerciseRow(profile_id, a) {
  return {
    profile_id,
    date: (a.start_date_local || '').slice(0, 10),
    name: a.name || a.sport_type || 'Strava activity',
    calories_burned: Math.round(a.calories || a.kilojoules || 0),
    strava_id: a.id,
    source: 'strava',
    sport_type: a.sport_type || a.type || null,
    trainer: !!a.trainer,
    moving_time: a.moving_time || a.elapsed_time || null,
  };
}

// Re-checks each given date against ALL of that day's saved Strava activities
// (call after upserting to exercise_logs), then ticks every habit marked
// auto_source = 'strava' on days whose workouts total 15+ minutes.
// Uses ignore-duplicates, so it never overwrites a value already logged for
// that day (manual entries always win).
async function applyStravaHabits(profile_id, dates) {
  dates = [...new Set(dates.filter(Boolean))];
  if (!dates.length) return 0;
  const pid = encodeURIComponent(profile_id);
  const acts = await sb(`exercise_logs?profile_id=eq.${pid}&source=eq.strava&date=in.(${dates.join(',')})&select=date,sport_type,trainer,moving_time`);
  const secs = {};
  (acts || []).filter(isWorkoutType).forEach(a => { secs[a.date] = (secs[a.date] || 0) + (a.moving_time || 0); });
  dates = dates.filter(d => (secs[d] || 0) >= MIN_DAILY_WORKOUT_SECONDS);
  if (!dates.length) return 0;
  const habits = await sb(`habits?profile_id=eq.${encodeURIComponent(profile_id)}&auto_source=eq.strava&select=id,target_type,target_value`);
  if (!habits || !habits.length) return 0;
  const rows = habits.flatMap(h => dates.map(date => ({
    habit_id: h.id, profile_id, date,
    value: h.target_type === 'quantity' ? (h.target_value || 1) : 1,
  })));
  await sb('habit_logs?on_conflict=habit_id,date', {
    method: 'POST',
    body: JSON.stringify(rows),
    headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
  });
  return rows.length;
}

module.exports = { sb, getAccessToken, isWorkoutType, MIN_DAILY_WORKOUT_SECONDS, toExerciseRow, applyStravaHabits };
