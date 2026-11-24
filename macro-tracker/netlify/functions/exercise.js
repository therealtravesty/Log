const { query, ok, err } = require('./db');

exports.handler = async (event) => {
  const method = event.httpMethod;
  const params = event.queryStringParameters || {};

  try {
    if (method === 'GET') {
      const { profile_id, date } = params;
      if (!profile_id) return err('Missing profile_id', 400);
      let path = `exercise_logs?profile_id=eq.${profile_id}&order=created_at.asc&limit=1000000`;
      if (date) path += `&date=eq.${date}`;
      const rows = await query(path);
      return ok(rows);
    }

    if (method === 'POST') {
      const { profile_id, date, name, calories_burned } = JSON.parse(event.body);
      const result = await query('exercise_logs', {
        method: 'POST',
        body: JSON.stringify({ profile_id, date, name, calories_burned }),
      });
      return ok(result);
    }

    // Details Garmin can't know (treadmill speed/incline, machine level).
    // Kept in their own column so Garmin syncs never overwrite them.
    if (method === 'PATCH') {
      const { id } = params;
      if (!id) return err('Missing id', 400);
      const body = JSON.parse(event.body || '{}');
      const d = body.details && typeof body.details === 'object' ? body.details : {};
      const num = (v, lo, hi) => { const n = parseFloat(v); return Number.isFinite(n) && n >= lo && n <= hi ? Math.round(n * 10) / 10 : null; };
      const details = { speed_mph: num(d.speed_mph, 0.5, 20), incline_pct: num(d.incline_pct, -5, 40), level: num(d.level, 1, 40), floors: num(d.floors, 1, 3000) };
      Object.keys(details).forEach(k => details[k] == null && delete details[k]);
      const result = await query(`exercise_logs?id=eq.${encodeURIComponent(id)}`, {
        method: 'PATCH', body: JSON.stringify({ details: Object.keys(details).length ? details : null }), prefer: 'return=representation',
      });
      return ok(result);
    }

    if (method === 'DELETE') {
      const { id } = params;
      if (!id) return err('Missing id', 400);
      await query(`exercise_logs?id=eq.${id}`, {
        method: 'DELETE',
        prefer: 'return=minimal',
      });
      return ok({ deleted: true });
    }

    return err('Method not allowed', 405);
  } catch (e) {
    return err(e.message);
  }
};
