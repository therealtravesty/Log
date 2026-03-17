const { query, ok, err } = require('./db');

exports.handler = async (event) => {
  const method = event.httpMethod;
  const params = event.queryStringParameters || {};

  try {
    if (method === 'GET') {
      const { profile_id } = params;
      if (!profile_id) return err('Missing profile_id', 400);
      const rows = await query(`saved_meals?profile_id=eq.${profile_id}&order=created_at.asc`);
      return ok(rows);
    }

    if (method === 'POST') {
      const { profile_id, name, foods } = JSON.parse(event.body);
      const result = await query('saved_meals', {
        method: 'POST',
        body: JSON.stringify({ profile_id, name, foods }),
      });
      return ok(result);
    }

    if (method === 'DELETE') {
      const { id } = params;
      if (!id) return err('Missing id', 400);
      await query(`saved_meals?id=eq.${id}`, {
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
