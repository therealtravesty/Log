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
      // Only send columns that exist in the standard food_logs schema
      // base_* columns are optional extras — omit them to avoid schema mismatch errors
      const row = {
        profile_id:    body.profile_id,
        date:          body.date,
        food_id:       body.food_id,
        name:          body.name,
        cal:           body.cal,
        pro:           body.pro,
        carb:          body.carb,
        fat:           body.fat,
        sat_fat:       body.sat_fat || 0,
        sug:           body.sug || 0,
        sod:           body.sod || 0,
        fib:           body.fib || 0,
        meal:          body.meal || 'uncategorized',
        serving_mult:  body.serving_mult  || 1,
        serving_label: body.serving_label || '1 serving',
        is_drink:      body.is_drink || false,
      };
      // Include base_* columns only if present — won't break if columns don't exist yet
      // They should be added to Supabase via: ALTER TABLE food_logs ADD COLUMN IF NOT EXISTS base_cal int, ...
      if (body.base_cal !== undefined) {
        Object.assign(row, {
          base_cal:     body.base_cal,
          base_pro:     body.base_pro,
          base_carb:    body.base_carb,
          base_fat:     body.base_fat,
          base_sat_fat: body.base_sat_fat || 0,
          base_sug:     body.base_sug     || 0,
          base_sod:     body.base_sod     || 0,
          base_fib:     body.base_fib     || 0,
        });
      }
      const result = await query('food_logs', {
        method: 'POST',
        body: JSON.stringify(row),
        prefer: 'return=representation',
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
