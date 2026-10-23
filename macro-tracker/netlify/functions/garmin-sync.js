// netlify/functions/garmin-sync.js
// POST /api/garmin-sync  { profile_id, days?: 1-120, end?: 'YYYY-MM-DD' }
// The app's "Sync now" (and backfill). Returns what was saved plus a per-source
// report (counts + field names) so mappings can be checked.
const { syncGarmin } = require('./garmin-core');
exports.handler = async (event) => {
  const json = (c, b) => ({ statusCode: c, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
  if (event.httpMethod !== 'POST') return json(405, { error: 'Use POST' });
  try {
    const { profile_id, days, end } = JSON.parse(event.body || '{}');
    return json(200, await syncGarmin({ profileId: profile_id, days, end }));
  } catch (e) { return json(500, { error: e.name === 'AbortError' ? 'Garmin took too long; try again' : e.message }); }
};
