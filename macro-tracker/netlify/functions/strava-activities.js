// netlify/functions/strava-activities.js
//
// GET /api/strava-activities?profile_id=X&date=YYYY-MM-DD
//   → Returns activities that started on that date in the athlete's local TZ
//   → Refreshes the access token automatically if expired
//   → Returns [] if the profile isn't connected
//
// Response shape:
//   [{ id, name, type, calories_burned, distance_m, moving_time_s, start_local }]

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const STRAVA_CLIENT_ID = process.env.STRAVA_CLIENT_ID;
const STRAVA_CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET;

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const json = (statusCode, body) => ({ statusCode, headers, body: JSON.stringify(body) });

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
    const e = new Error(data?.message || `Supabase ${res.status}`);
    e.status = res.status; e.data = data;
    throw e;
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
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method not allowed' });

  if (!SUPABASE_URL || !SUPABASE_KEY || !STRAVA_CLIENT_ID || !STRAVA_CLIENT_SECRET) {
    return json(500, { error: 'env vars not configured' });
  }

  const qs = event.queryStringParameters || {};
  if (!qs.profile_id || !qs.date) return json(400, { error: 'profile_id and date required' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(qs.date)) return json(400, { error: 'date must be YYYY-MM-DD' });

  try {
    const rows = await sb(
      `strava_tokens?profile_id=eq.${encodeURIComponent(qs.profile_id)}&select=*`
    );
    if (!rows || !rows.length) return json(200, []); // Not connected — empty list, not an error.

    let token = rows[0];
    const now = Math.floor(Date.now() / 1000);
    let access = token.access_token;
    if (now >= (token.expires_at || 0) - 60) {
      access = await refreshToken(qs.profile_id, token.refresh_token);
    }

    // Strava's `after`/`before` are unix timestamps. We use UTC midnight for
    // the requested date with a generous +/- 12-hour buffer so that any
    // activity starting on that local day is captured regardless of TZ.
    const dayMid = Math.floor(new Date(qs.date + 'T00:00:00Z').getTime() / 1000);
    const after  = dayMid - 12 * 3600;
    const before = dayMid + 36 * 3600; // 24h day + 12h forward buffer

    const sRes = await fetch(
      `https://www.strava.com/api/v3/athlete/activities?after=${after}&before=${before}&per_page=50`,
      { headers: { Authorization: `Bearer ${access}` } }
    );
    if (!sRes.ok) {
      const errText = await sRes.text();
      return json(sRes.status, { error: 'Strava API error', detail: errText });
    }
    const activities = await sRes.json();

    // Filter to activities whose LOCAL start date matches the requested date.
    // start_date_local is ISO without TZ ("2026-04-12T07:30:00Z" but it's local).
    const filtered = (activities || []).filter(a =>
      typeof a.start_date_local === 'string' && a.start_date_local.slice(0, 10) === qs.date
    );

    const out = filtered.map(a => ({
      id: a.id,
      name: a.name,
      type: a.sport_type || a.type,
      calories_burned: Math.round(a.calories || a.kilojoules || 0),
      distance_m: a.distance,
      moving_time_s: a.moving_time,
      start_local: a.start_date_local,
    }));

    return json(200, out);
  } catch (e) {
    return json(500, { error: e.message || 'Internal error' });
  }
};
