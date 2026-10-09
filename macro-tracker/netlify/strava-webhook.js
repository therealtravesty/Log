// netlify/functions/strava-webhook.js
//
// Receives Strava push events so new activities sync on their own — no need
// to open the app or tap Sync.
//
//   GET  /api/strava-webhook   Strava's one-time subscription handshake
//   POST /api/strava-webhook   activity create/update/delete + deauthorize events
//
// On a new activity: saves it to exercise_logs, then totals that day's
// workouts and ticks any habit marked "Auto-complete from Strava" once they
// reach 15 minutes (rule in strava-lib.js).
//
// Env: STRAVA_VERIFY_TOKEN (any random string, also used when creating the
// subscription) plus the existing Strava + Supabase vars.
//
// Strava expects a 200 within 2 seconds. Writes are idempotent upserts, so if
// a slow response makes Strava retry, nothing is duplicated.

const { sb, getAccessToken, toExerciseRow, applyStravaHabits } = require('./strava-lib');

const VERIFY_TOKEN = process.env.STRAVA_VERIFY_TOKEN;
const json = (statusCode, body) => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

exports.handler = async (event) => {
  // ── Subscription handshake ──
  if (event.httpMethod === 'GET') {
    const q = event.queryStringParameters || {};
    if (q['hub.mode'] === 'subscribe' && VERIFY_TOKEN && q['hub.verify_token'] === VERIFY_TOKEN) {
      return json(200, { 'hub.challenge': q['hub.challenge'] });
    }
    return json(403, { error: 'verification failed' });
  }
  if (event.httpMethod !== 'POST') return json(405, { error: 'Use POST' });

  let evt;
  try { evt = JSON.parse(event.body || '{}'); } catch (_) { return json(400, { error: 'bad json' }); }
  const { object_type, object_id, aspect_type, owner_id, updates = {} } = evt;
  console.log('[strava-webhook]', object_type, aspect_type, object_id, 'owner', owner_id);

  try {
    // Every profile connected to this Strava athlete
    const tokens = await sb(`strava_tokens?athlete_id=eq.${encodeURIComponent(owner_id)}&select=*`);
    if (!tokens || !tokens.length) return json(200, { ignored: 'unknown athlete' });

    // Athlete revoked access in Strava settings
    if (object_type === 'athlete' && String(updates.authorized) === 'false') {
      await sb(`strava_tokens?athlete_id=eq.${encodeURIComponent(owner_id)}`, { method: 'DELETE' });
      return json(200, { deauthorized: true });
    }
    if (object_type !== 'activity') return json(200, { ignored: object_type });

    for (const t of tokens) {
      const pid = encodeURIComponent(t.profile_id);
      if (aspect_type === 'delete') {
        // Remove the exercise entry; a habit already ticked stays ticked
        await sb(`exercise_logs?profile_id=eq.${pid}&strava_id=eq.${encodeURIComponent(object_id)}`, { method: 'DELETE' });
        continue;
      }
      const access = await getAccessToken(t);
      const res = await fetch(`https://www.strava.com/api/v3/activities/${object_id}`, { headers: { Authorization: `Bearer ${access}` } });
      if (!res.ok) { console.warn('[strava-webhook] activity fetch', res.status); continue; }
      const a = await res.json();
      const row = toExerciseRow(t.profile_id, a);
      if (!row.date) continue;
      await sb('exercise_logs?on_conflict=profile_id,strava_id', {
        method: 'POST',
        body: JSON.stringify([row]),
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      });
      // Tick habits on new activities, or when the activity's type was changed
      // (e.g. a watch saved it as Walk and it was corrected to Weight Training).
      // Plain edits like renaming don't re-tick a day you unticked yourself.
      if (aspect_type === 'create' || 'type' in updates || 'sport_type' in updates) {
        await applyStravaHabits(t.profile_id, [row.date]); // totals the whole day
      }
    }
    return json(200, { ok: true });
  } catch (e) {
    console.error('[strava-webhook] error', e.message);
    return json(500, { error: e.message }); // non-200 → Strava retries (idempotent)
  }
};
