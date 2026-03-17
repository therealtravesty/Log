const { query, ok, err } = require('./db');

exports.handler = async (event) => {
  const method = event.httpMethod;
  const params = event.queryStringParameters || {};

  try {
    if (method === 'GET') {
      const { profile_id } = params;
      if (!profile_id) return err('Missing profile_id', 400);
      const rows = await query(`settings?profile_id=eq.${profile_id}`);
      return ok(rows?.[0] || null);
    }

    if (method === 'POST') {
      const { profile_id, data } = JSON.parse(event.body);
      const result = await query('settings', {
        method: 'POST',
        body: JSON.stringify({ profile_id, data }),
        prefer: 'resolution=merge-duplicates,return=representation',
      });
      return ok(result);
    }

    return err('Method not allowed', 405);
  } catch (e) {
    return err(e.message);
  }
};
