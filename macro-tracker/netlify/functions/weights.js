const { query, ok, err } = require('./db');

exports.handler = async (event) => {
  const method = event.httpMethod;
  const params = event.queryStringParameters || {};

  try {
    if (method === 'GET') {
      const { profile_id } = params;
      if (!profile_id) return err('Missing profile_id', 400);
      const rows = await query(`weights?profile_id=eq.${profile_id}&order=date.asc`);
      return ok(rows);
    }

    if (method === 'POST') {
      const { profile_id, date, weight } = JSON.parse(event.body);
      // Upsert — insert or update if same profile+date exists
      const result = await query('weights', {
        method: 'POST',
        body: JSON.stringify({ profile_id, date, weight }),
        prefer: 'resolution=merge-duplicates,return=representation',
      });
      return ok(result);
    }

    if (method === 'DELETE') {
      const { profile_id, date } = params;
      if (!profile_id || !date) return err('Missing profile_id or date', 400);
      await query(`weights?profile_id=eq.${profile_id}&date=eq.${date}`, {
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
