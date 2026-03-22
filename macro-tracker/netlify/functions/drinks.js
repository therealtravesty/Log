const { query, ok, err } = require('./db');

exports.handler = async (event) => {
  const method = event.httpMethod;
  const params = event.queryStringParameters || {};

  try {
    if (method === 'GET') {
      const { profile_id, date } = params;
      if (!profile_id) return err('Missing profile_id', 400);
      let path = `drinks?profile_id=eq.${profile_id}&order=date.asc,time.asc&limit=1000000`;
      if (date) path += `&date=eq.${date}`;
      const rows = await query(path);
      return ok(rows);
    }

    if (method === 'POST') {
      const body = JSON.parse(event.body);
      const result = await query('drinks', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      return ok(result);
    }

    if (method === 'DELETE') {
      const { id } = params;
      if (!id) return err('Missing id', 400);
      await query(`drinks?id=eq.${id}`, { method: 'DELETE', prefer: 'return=minimal' });
      return ok({ deleted: true });
    }

    return err('Method not allowed', 405);
  } catch (e) {
    return err(e.message);
  }
};
