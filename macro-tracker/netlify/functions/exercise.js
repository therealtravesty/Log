const { query, ok, err } = require('./db');

exports.handler = async (event) => {
  const method = event.httpMethod;
  const params = event.queryStringParameters || {};

  try {
    if (method === 'GET') {
      const { profile_id, date } = params;
      if (!profile_id) return err('Missing profile_id', 400);
      let path = `exercise_logs?profile_id=eq.${profile_id}&order=created_at.asc`;
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
