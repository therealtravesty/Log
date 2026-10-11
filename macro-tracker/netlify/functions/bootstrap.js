// netlify/functions/bootstrap.js
//
// GET /api/bootstrap?profile_id=...&since=YYYY-MM-DD
//
// Everything the app loads at startup, in ONE request instead of ten:
// one function wake-up instead of ten, and one round trip on cellular.
// It calls the existing functions' handlers directly, so each piece comes
// back in exactly the format the app already expects. Any piece that fails
// is just left out — the app then fetches that one the old way.

const PARTS = {
  'foods':                  ['./foods',        q => ({ profile_id: q.profile_id, since: q.since })],
  'weights':                ['./weights',      q => ({ profile_id: q.profile_id })],
  'exercise':               ['./exercise',     q => ({ profile_id: q.profile_id })],
  'saved-meals':            ['./saved-meals',  q => ({ profile_id: q.profile_id })],
  'custom-foods':           ['./custom-foods', q => ({ profile_id: q.profile_id })],
  'custom-foods:exercise':  ['./custom-foods', q => ({ profile_id: q.profile_id, type: 'exercise' })],
  'habits':                 ['./habits',       q => ({ profile_id: q.profile_id })],
  'habit-logs':             ['./habit-logs',   q => ({ profile_id: q.profile_id })],
  'health-sync':            ['./health-sync',  q => ({ profile_id: q.profile_id, days: '120' })],
  'settings':               ['./settings',     q => ({ profile_id: q.profile_id })],
};

// Static requires so Netlify's bundler includes each function
const HANDLERS = {
  './foods': require('./foods'), './weights': require('./weights'), './exercise': require('./exercise'),
  './saved-meals': require('./saved-meals'), './custom-foods': require('./custom-foods'),
  './habits': require('./habits'), './habit-logs': require('./habit-logs'),
  './health-sync': require('./health-sync'), './settings': require('./settings'),
};

exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  if (event.httpMethod !== 'GET') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Use GET' }) };
  if (!q.profile_id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'profile_id required' }) };

  const out = {};
  await Promise.all(Object.entries(PARTS).map(async ([key, [mod, params]]) => {
    try {
      const res = await HANDLERS[mod].handler({ httpMethod: 'GET', queryStringParameters: params(q), headers: {}, body: null });
      if (res && res.statusCode === 200) out[key] = JSON.parse(res.body);
    } catch (_) { /* leave it out; the app falls back for this piece */ }
  }));
  return { statusCode: 200, headers, body: JSON.stringify(out) };
};
