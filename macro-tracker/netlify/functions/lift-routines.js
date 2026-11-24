const { query, ok, err } = require('./db');

// Saved strength routines ("Push Day"): a name plus a list of exercises.
// exercises: [{ exercise, muscle_group }]

const cleanList = list => (Array.isArray(list) ? list : [])
  .map(x => ({ exercise: String(x.exercise || '').trim().slice(0, 80), muscle_group: String(x.muscle_group || '').slice(0, 40) }))
  .filter(x => x.exercise)
  .slice(0, 30);

exports.handler = async (event) => {
  const method = event.httpMethod;
  const params = event.queryStringParameters || {};

  try {
    if (method === 'GET') {
      const { profile_id } = params;
      if (!profile_id) return err('Missing profile_id', 400);
      const rows = await query(`lift_routines?profile_id=eq.${encodeURIComponent(profile_id)}&order=name.asc&limit=1000`);
      return ok(rows || []);
    }

    if (method === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const name = String(body.name || '').trim().slice(0, 60);
      const exercises = cleanList(body.exercises);
      if (!body.profile_id || !name || !exercises.length) return err('Missing profile_id, name or exercises', 400);
      const result = await query('lift_routines', {
        method: 'POST', body: JSON.stringify({ profile_id: body.profile_id, name, exercises }), prefer: 'return=representation',
      });
      return ok(result);
    }

    if (method === 'DELETE') {
      const { id } = params;
      if (!id) return err('Missing id', 400);
      await query(`lift_routines?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE', prefer: 'return=minimal' });
      return ok({ deleted: true });
    }

    return err('Method not allowed', 405);
  } catch (e) {
    return err(e.message);
  }
};
