const { query, ok, err } = require('./db');

exports.handler = async (event) => {
  const method = event.httpMethod;

  try {
    if (method === 'GET') {
      const profiles = await query('profiles?order=created_at.asc');
      return ok(profiles);
    }

    if (method === 'POST') {
      const { id, name, color } = JSON.parse(event.body);
      const result = await query('profiles', {
        method: 'POST',
        body: JSON.stringify({ id, name, color }),
      });
      return ok(result);
    }

    if (method === 'DELETE') {
      const id = event.queryStringParameters?.id;
      if (!id) return err('Missing id', 400);
      await query(`profiles?id=eq.${id}`, {
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
