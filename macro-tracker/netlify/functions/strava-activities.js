// netlify/functions/strava-activities.js
//
// POST /api/strava-activities  { profile_id, days }
//   → Pulls the last N days of activities from Strava (default 90)
//   → Upserts each activity into exercise_logs (dedup by profile_id+strava_id)
//   → Returns { synced, total_fetched }
//
// Strava activities live in exercise_logs alongside manual entries. The
// `source` column distinguishes them ('strava' vs 'manual') and `strava_id`
// holds the Strava activity id for dedup. The frontend doesn't maintain a
// separate Strava cache anymore — everything reads from exercise_logs.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const STRAVA_CLIENT_ID = process.env.STRAVA_CLIENT_ID;
const STRAVA_CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET;

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const json = (sc, body) => ({ statusCode: sc, headers, body: JSON.stringify(body) });

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

async function refreshToken(profile_id, refresh_token) {
  const res = await fetch('https://www.strava.com/api/v3/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: STRAVA_CLIENT_ID,
      client_secret: STRAVA_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || 'Token refresh failed');
  await sb(`strava_tokens?profile_id=eq.${encodeURIComponent(profile_id)}`, {
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

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Use POST' });
  if (!SUPABASE_URL || !SUPABASE_KEY || !STRAVA_CLIENT_ID || !STRAVA_CLIENT_SECRET) {
    return json(500, { error: 'env vars not configured' });
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const profile_id = body.profile_id;
    const days = Math.min(parseInt(body.days) || 90, 365);
    if (!profile_id) return json(400, { error: 'profile_id required' });

    const rows = await sb(`strava_tokens?profile_id=eq.${encodeURIComponent(profile_id)}&select=*`);
    if (!rows || !rows.length) return json(200, { synced: 0, error: 'not connected' });

    let token = rows[0];
    const now = Math.floor(Date.now() / 1000);
    let access = token.access_token;
    if (now >= (token.expires_at || 0) - 60) {
      access = await refreshToken(profile_id, token.refresh_token);
    }

    // Pull activities for the requested window, paginating until empty.
    const after = Math.floor(Date.now() / 1000) - days * 86400;
    const allActivities = [];
    for (let page = 1; page <= 10; page++) {
      const sRes = await fetch(
        `https://www.strava.com/api/v3/athlete/activities?after=${after}&per_page=200&page=${page}`,
        { headers: { Authorization: `Bearer ${access}` } }
      );
      if (!sRes.ok) {
        const errText = await sRes.text();
        return json(sRes.status, { error: 'Strava API error', detail: errText.slice(0, 300) });
      }
      const pageData = await sRes.json();
      if (!Array.isArray(pageData) || !pageData.length) break;
      allActivities.push(...pageData);
      if (pageData.length < 200) break;
    }

    // For activities missing summary calories, fetch detail in parallel.
    // Some activity types (weight training, walks) only expose calories via detail.
    await Promise.all(allActivities.map(async a => {
      if (a.calories && a.calories > 0) return;
      try {
        const dRes = await fetch(`https://www.strava.com/api/v3/activities/${a.id}`, {
          headers: { Authorization: `Bearer ${access}` },
        });
        if (dRes.ok) {
          const detail = await dRes.json();
          if (detail.calories) a.calories = detail.calories;
        }
      } catch(_) { /* leave at 0 on failure */ }
    }));

    // Upsert into exercise_logs. The partial unique index on
    // (profile_id, strava_id) WHERE strava_id IS NOT NULL handles dedup.
    const upsertRows = allActivities.map(a => ({
      profile_id,
      date: (a.start_date_local || '').slice(0, 10),
      name: a.name || a.sport_type || 'Strava activity',
      calories_burned: Math.round(a.calories || a.kilojoules || 0),
      strava_id: a.id,
      source: 'strava',
    })).filter(r => r.date);

    let synced = 0;
    if (upsertRows.length) {
      await sb('exercise_logs?on_conflict=profile_id,strava_id', {
        method: 'POST',
        body: JSON.stringify(upsertRows),
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      });
      synced = upsertRows.length;
    }

    return json(200, { synced, days, total_fetched: allActivities.length });
  } catch (e) {
    return json(500, { error: e.message || 'Internal error' });
  }
};
