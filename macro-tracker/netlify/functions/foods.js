const { query, ok, err } = require('./db');

exports.handler = async (event) => {
  const method = event.httpMethod;
  const params = event.queryStringParameters || {};

  try {
    if (method === 'GET') {
      // Get all food logs for a profile, optionally filtered by date
      const { profile_id, date } = params;
      if (!profile_id) return err('Missing profile_id', 400);
      let path = `food_logs?profile_id=eq.${profile_id}&order=created_at.desc&limit=10000`;
      if (date) path += `&date=eq.${date}`;
      const rows = await query(path);
      return ok(rows);
    }

    if (method === 'POST') {
      const body = JSON.parse(event.body);
      // ensure meal field is present
      if (!body.meal) body.meal = 'uncategorized';
      const result = await query('food_logs', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      return ok(result);
    }

    if (method === 'DELETE') {
      const { id, profile_id, date } = params;
      if (id) {
        // Delete single food entry
        await query(`food_logs?id=eq.${id}`, {
          method: 'DELETE',
          prefer: 'return=minimal',
        });
      } else if (profile_id && date) {
        // Delete all entries for a day (reset day)
        await query(`food_logs?profile_id=eq.${profile_id}&date=eq.${date}`, {
          method: 'DELETE',
          prefer: 'return=minimal',
        });
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
