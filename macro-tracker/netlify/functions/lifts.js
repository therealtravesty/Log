const { query, ok, err } = require('./db');

// Strength log: one row per exercise per session — sets × reps @ weight (lbs).
// weight 0 = bodyweight.

const num = (v, d = 0) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };
const int = (v, d = 0) => Math.round(num(v, d));

function clean(body) {
  const row = {};
  if (body.profile_id !== undefined) row.profile_id = body.profile_id;
  if (body.date !== undefined)        row.date = body.date;
  if (body.exercise !== undefined)    row.exercise = String(body.exercise).trim().slice(0, 80);
  if (body.muscle_group !== undefined) row.muscle_group = String(body.muscle_group || '').slice(0, 40);
  if (body.sets !== undefined)        row.sets = Math.max(1, int(body.sets, 1));
  if (body.reps !== undefined)        row.reps = Math.max(0, int(body.reps, 0));
  if (body.weight !== undefined)      row.weight = Math.max(0, Math.round(num(body.weight) * 10) / 10);
  if (body.note !== undefined)        row.note = String(body.note || '').slice(0, 200);
  return row;
}

exports.handler = async (event) => {
  const method = event.httpMethod;
  const params = event.queryStringParameters || {};

  try {
    if (method === 'GET') {
      const { profile_id } = params;
      if (!profile_id) return err('Missing profile_id', 400);
      const rows = await query(`lift_logs?profile_id=eq.${encodeURIComponent(profile_id)}&order=date.asc,id.asc&limit=1000000`);
      return ok(rows || []);
    }

    if (method === 'POST') {
      const row = clean(JSON.parse(event.body || '{}'));
      if (!row.profile_id || !row.date || !row.exercise) return err('Missing profile_id, date or exercise', 400);
      const result = await query('lift_logs', { method: 'POST', body: JSON.stringify(row), prefer: 'return=representation' });
      return ok(result);
    }

    if (method === 'PATCH') {
      const { id } = params;
      if (!id) return err('Missing id', 400);
      const row = clean(JSON.parse(event.body || '{}'));
      delete row.profile_id;
      const result = await query(`lift_logs?id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(row), prefer: 'return=representation' });
      return ok(result);
    }

    if (method === 'DELETE') {
      const { id } = params;
      if (!id) return err('Missing id', 400);
      await query(`lift_logs?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE', prefer: 'return=minimal' });
      return ok({ deleted: true });
    }

    return err('Method not allowed', 405);
  } catch (e) {
    return err(e.message);
  }
};
