// netlify/functions/strava-auth.js
//
// Handles two flows:
//   POST { profile_id, code }
//     → exchanges an OAuth code for tokens, stores them in strava_tokens
//   POST { profile_id, action: "disconnect" }
//     → deletes the row for that profile
//   GET ?profile_id=X
//     → returns { connected: true, athlete_id, expires_at } or { connected: false }
//
// Required env vars in Netlify:
//   STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET, SUPABASE_URL, SUPABASE_SERVICE_KEY
//
// Required SQL (run once if not already created):
//   create table if not exists strava_tokens (
//     profile_id    text primary key,
//     athlete_id    bigint,
//     access_token  text not null,
//     refresh_token text not null,
//     expires_at    bigint not null,
//     updated_at    timestamptz not null default now()
//   );
//   alter table strava_tokens enable row level security;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const STRAVA_CLIENT_ID = process.env.STRAVA_CLIENT_ID;
const STRAVA_CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET;

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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
      Prefer: 'return=representation,resolution=merge-duplicates',
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

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };

  if (!SUPABASE_URL || !SUPABASE_KEY || !STRAVA_CLIENT_ID || !STRAVA_CLIENT_SECRET) {
    return json(500, { error: 'Strava or Supabase env vars not configured' });
  }

  try {
    if (event.httpMethod === 'GET') {
      const profile_id = event.queryStringParameters?.profile_id;
      if (!profile_id) return json(400, { error: 'profile_id required' });
      const rows = await sb(
        `strava_tokens?profile_id=eq.${encodeURIComponent(profile_id)}&select=athlete_id,expires_at`
      );
      if (!rows || !rows.length) return json(200, { connected: false });
      return json(200, { connected: true, athlete_id: rows[0].athlete_id, expires_at: rows[0].expires_at });
    }

    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      if (!body.profile_id) return json(400, { error: 'profile_id required' });

      // ── Disconnect ────────────────────────────────────────────────
      if (body.action === 'disconnect') {
        await sb(`strava_tokens?profile_id=eq.${encodeURIComponent(body.profile_id)}`, { method: 'DELETE' });
        return json(200, { disconnected: true });
      }

      // ── Exchange OAuth code for tokens ────────────────────────────
      if (!body.code) return json(400, { error: 'code required' });

      const tokenRes = await fetch('https://www.strava.com/api/v3/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: STRAVA_CLIENT_ID,
          client_secret: STRAVA_CLIENT_SECRET,
          code: body.code,
          grant_type: 'authorization_code',
        }),
      });
      const tokenData = await tokenRes.json();
      if (!tokenRes.ok) {
        return json(400, { error: tokenData.message || 'Strava token exchange failed', detail: tokenData });
      }

      const row = {
        profile_id: body.profile_id,
        athlete_id: tokenData.athlete?.id || null,
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        expires_at: tokenData.expires_at,
        // Note: existing schema uses `created_at`, not `updated_at`. We write
        // it on every upsert anyway so it functions as a last-touched marker.
        created_at: new Date().toISOString(),
      };

      // Upsert via on_conflict on the primary key
      await sb('strava_tokens?on_conflict=profile_id', {
        method: 'POST',
        body: JSON.stringify(row),
        headers: { Prefer: 'return=representation,resolution=merge-duplicates' },
      });

      return json(200, {
        connected: true,
        athlete_id: row.athlete_id,
        athlete_name: tokenData.athlete ? `${tokenData.athlete.firstname || ''} ${tokenData.athlete.lastname || ''}`.trim() : null,
      });
    }

    return json(405, { error: 'Method not allowed' });
  } catch (e) {
    return json(500, { error: e.message || 'Internal error' });
  }
};
