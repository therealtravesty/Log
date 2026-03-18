const { query, ok, err } = require('./db');

exports.handler = async (event) => {
  const method = event.httpMethod;
  const params = event.queryStringParameters || {};

  try {
    if (method === 'GET') {
      const { profile_id, date_from, date_to } = params;
      if (!profile_id) return err('Missing profile_id', 400);
      let path = `habit_logs?profile_id=eq.${profile_id}&order=date.asc`;
      if (date_from) path += `&date=gte.${date_from}`;
      if (date_to)   path += `&date=lte.${date_to}`;
      const rows = await query(path);
      return ok(rows);
    }

    if (method === 'POST') {
      const body = JSON.parse(event.body);
      const result = await query('habit_logs', {
        method: 'POST',
        body: JSON.stringify(body),
        prefer: 'resolution=merge-duplicates,return=representation',
      });
      return ok(result);
    }

    if (method === 'DELETE') {
      const { habit_id, date } = params;
      if (!habit_id || !date) return err('Missing habit_id or date', 400);
      await query(`habit_logs?habit_id=eq.${habit_id}&date=eq.${date}`, {
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
