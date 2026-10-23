// netlify/functions/garmin-sync-scheduled.js
// Runs on a schedule (see netlify.toml) so data arrives without opening the app.
// Env: GARMIN_PROFILE_ID (your Lōg profile id)
const { syncGarmin } = require('./garmin-core');
exports.handler = async () => {
  const profileId = process.env.GARMIN_PROFILE_ID;
  if (!profileId) { console.log('garmin-sync-scheduled: set GARMIN_PROFILE_ID in Netlify'); return { statusCode: 200 }; }
  try { const r = await syncGarmin({ profileId, days: 3 }); console.log(r.message, JSON.stringify(r.found)); }
  catch (e) { console.log('garmin-sync-scheduled failed:', e.message); }
  return { statusCode: 200 };
};
