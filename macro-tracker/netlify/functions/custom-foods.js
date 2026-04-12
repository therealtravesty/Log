// netlify/functions/custom-foods.js
//
// CRUD for the custom_foods table. Stores both user-saved foods and
// user-saved exercises in a single table, distinguished by a name prefix:
//   "[cf] " — custom food
//   "[ce] " — custom exercise
//
// The `foods` column is a JSONB array containing the macro/exercise payload.
// The frontend (loadCustomFoodsFromServer / loadCustomExercisesFromServer)
// reads `r.foods[0]` and strips the prefix from `r.name`.
//
// Routes (all under /api/custom-foods):
//   GET    ?profile_id=X                 → list foods (rows with [cf] prefix)
//   GET    ?profile_id=X&type=exercise   → list exercises (rows with [ce] prefix)
//   POST   { profile_id, name, ...payload }
//          → insert; if body has _type:"exercise" it's stored as [ce], else [cf]
//   DELETE ?id=N                         → delete by row id
//
// Required SQL to create the table (run once in Supabase SQL editor):
//
//   create table if not exists custom_foods (
//     id          bigint generated always as identity primary key,
//     profile_id  text not null,
//     name        text not null,
//     foods       jsonb not null default '[]'::jsonb,
//     created_at  timestamptz not null default now()
//   );
//   create index if not exists custom_foods_profile_idx on custom_foods (profile_id);
//   create unique index if not exists custom_foods_profile_name_uq
//     on custom_foods (profile_id, lower(name));
//   alter table custom_foods enable row level security;
//
// The unique index on (profile_id, lower(name)) gives us server-side dedup
// so the auto-learn POST is idempotent — repeated logs of the same food name
// will hit the unique constraint and we treat that as success.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const json = (statusCode, body) => ({ statusCode, headers, body: JSON.stringify(body) });

async function sb(path, init = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: init.method === 'POST' ? 'return=representation' : '',
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new Error(data?.message || `Supabase ${res.status}`);
    err.status = res.status;
    err.code = data?.code;
    err.data = data;
    throw err;
  }
  return data;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return json(500, { error: 'Supabase env vars not configured' });
  }

  try {
    const qs = event.queryStringParameters || {};

    // ── GET: list custom foods or exercises for a profile ───────────
    if (event.httpMethod === 'GET') {
      if (!qs.profile_id) return json(400, { error: 'profile_id required' });
      const prefix = qs.type === 'exercise' ? '[ce] ' : '[cf] ';
      // PostgREST `like` filter — escape special chars in the prefix.
      // Brackets are literal in `like` patterns so this works as-is.
      const filter = `name=like.${encodeURIComponent(prefix)}*`;
      const rows = await sb(
        `custom_foods?profile_id=eq.${encodeURIComponent(qs.profile_id)}&${filter}&order=created_at.desc`
      );
      return json(200, rows || []);
    }

    // ── POST: insert a new custom food or exercise ──────────────────
    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      if (!body.profile_id || !body.name) {
        return json(400, { error: 'profile_id and name required' });
      }

      let row;
      if (body._type === 'exercise') {
        row = {
          profile_id: body.profile_id,
          name: '[ce] ' + body.name,
          foods: [{
            calories_burned: Number(body._calories_burned) || 0,
            note: body._note || '',
          }],
        };
      } else {
        row = {
          profile_id: body.profile_id,
          name: '[cf] ' + body.name,
          foods: [{
            cal:    Number(body.cal)    || 0,
            pro:    Number(body.pro)    || 0,
            carb:   Number(body.carb)   || 0,
            fat:    Number(body.fat)    || 0,
            satFat: Number(body.satFat) || 0,
            sug:    Number(body.sug)    || 0,
            sod:    Number(body.sod)    || 0,
            fib:    Number(body.fib)    || 0,
            servingLabel: body.servingLabel || '1 serving',
          }],
        };
      }

      try {
        const inserted = await sb('custom_foods', {
          method: 'POST',
          body: JSON.stringify(row),
        });
        return json(200, inserted);
      } catch (e) {
        // 23505 = unique_violation — name already exists for this profile.
        // Treat as success so the frontend's auto-learn is idempotent and
        // doesn't surface a "Could not save" toast on every repeat log.
        if (e.code === '23505' || e.status === 409) {
          return json(200, []);
        }
        throw e;
      }
    }

    // ── DELETE: remove a row by id ──────────────────────────────────
    if (event.httpMethod === 'DELETE') {
      if (!qs.id) return json(400, { error: 'id required' });
      await sb(`custom_foods?id=eq.${encodeURIComponent(qs.id)}`, { method: 'DELETE' });
      return json(200, { deleted: true });
    }

    return json(405, { error: 'Method not allowed' });
  } catch (e) {
    return json(500, { error: e.message || 'Internal error' });
  }
};
