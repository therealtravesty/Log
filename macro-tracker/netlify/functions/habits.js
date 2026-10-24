const { query, ok, err } = require('./db');

exports.handler = async (event) => {
  const method = event.httpMethod;
  const params = event.queryStringParameters || {};

  try {
    if (method === 'GET') {
      const { profile_id } = params;
      if (!profile_id) return err('Missing profile_id', 400);
      const rows = await query(`habits?profile_id=eq.${profile_id}&order=sort_order.asc,created_at.asc`);
      return ok(rows);
    }

    if (method === 'POST') {
      const body = JSON.parse(event.body);
      const result = await query('habits', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      return ok(result);
    }

    if (method === 'PATCH') {
      const { id } = params;
      if (!id) return err('Missing id', 400);
      const body = JSON.parse(event.body);
      // If the table is missing a column the app sends (e.g. after a new
      // feature), drop that field and retry, so one unknown field can't block
      // the rest of the update. The response lists anything that was skipped.
      const skipped = [];
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          const result = await query(`habits?id=eq.${id}`, {
            method: 'PATCH',
            body: JSON.stringify(body),
            prefer: 'return=representation',
          });
          return ok(skipped.length ? { result, skipped } : result);
        } catch (e) {
          const m = String(e.message).match(/Could not find the '([^']+)' column/);
          if (!m || !(m[1] in body)) throw e;
          skipped.push(m[1]); delete body[m[1]];
        }
      }
      return err('Habit update failed', 500);
    }

    if (method === 'DELETE') {
      const { id } = params;
      if (!id) return err('Missing id', 400);
      await query(`habits?id=eq.${id}`, {
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
