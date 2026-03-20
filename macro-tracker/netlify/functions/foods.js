const { query, ok, err } = require('./db');

exports.handler = async (event) => {
  const method = event.httpMethod;
  const params = event.queryStringParameters || {};

  try {
    if (method === 'GET') {
      const { profile_id, date } = params;
      if (!profile_id) return err('Missing profile_id', 400);
      let path = `food_logs?profile_id=eq.${profile_id}&order=created_at.asc&limit=1000000`;
      if (date) path += `&date=eq.${date}`;
      const rows = await query(path);
      return ok(rows);
    }

    if (method === 'POST') {
      const body = JSON.parse(event.body);
      const meal = body.meal || 'uncategorized';
      const result = await query('food_logs', {
        method: 'POST',
        body: JSON.stringify({ ...body, meal }),
      });
      return ok(result);
    }

    if (method === 'PATCH') {
      const { id } = params;
      if (!id) return err('Missing id', 400);
      const body = JSON.parse(event.body);
      const result = await query(`food_logs?id=eq.${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
        prefer: 'return=representation',
      });
      return ok(result);
    }

    if (method === 'DELETE') {
      const { id, profile_id: pid, date: d } = params;
      if (id) {
        await query(`food_logs?id=eq.${id}`, { method: 'DELETE', prefer: 'return=minimal' });
      } else if (pid && d) {
        await query(`food_logs?profile_id=eq.${pid}&date=eq.${d}`, { method: 'DELETE', prefer: 'return=minimal' });
      } else {
        return err('Missing id or profile_id+date', 400);
      }
      return ok({ deleted: true });
    }

    return err('Method not allowed', 405);
  } catch (e) {
    return err(e.message);
  }
};
