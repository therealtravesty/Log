const { query, ok, err } = require('./db');

exports.handler = async (event) => {
  const method = event.httpMethod;
  const params = event.queryStringParameters || {};

  try {
    if (method === 'GET') {
      const { profile_id, date } = params;
      if (!profile_id) return err('Missing profile_id', 400);
      let path = `water_logs?profile_id=eq.${profile_id}&order=date.asc`;
      if (date) path += `&date=eq.${date}`;
      const rows = await query(path);
      return ok(rows);
    }

    if (method === 'POST') {
      const { profile_id, date, oz } = JSON.parse(event.body);
      const result = await query('water_logs', {
        method: 'POST',
        body: JSON.stringify({ profile_id, date, oz }),
        prefer: 'resolution=merge-duplicates,return=representation',
      });
      return ok(result);
    }

    if (method === 'DELETE') {
      const { profile_id, date } = params;
      if (!profile_id || !date) return err('Missing profile_id or date', 400);
      await query(`water_logs?profile_id=eq.${profile_id}&date=eq.${date}`, {
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
