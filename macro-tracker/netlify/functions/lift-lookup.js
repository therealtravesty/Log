// POST /api/lift-lookup
// { query?: "chest press machine", imageData?: base64, mediaType?: "image/jpeg", known?: ["Bench Press", ...] }
// → { name, muscle_group, equipment, note }
//
// Turns a description or a photo of a gym machine into a standard exercise name.
// `known` is the list of exercises already in the log, so the same lift keeps
// the same name every time (progress charts group by name).

async function fetchWithTimeout(url, options, ms = 22000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(id); }
}

const json = (statusCode, body) => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Use POST' });

  try {
    const { query, imageData, mediaType, known } = JSON.parse(event.body || '{}');
    if (!query && !imageData) return json(400, { error: 'Describe the exercise or add a photo' });
    if (imageData && imageData.length > 5 * 1024 * 1024) return json(413, { error: 'Photo too large — try again' });

    const knownList = (Array.isArray(known) ? known : []).map(s => String(s).slice(0, 80)).slice(0, 150);

    const instructions = `You identify strength-training exercises for a workout log.
${imageData
  ? `The photo shows gym equipment (a machine, cable station, bench, rack or free weights), possibly with an instruction placard.${query ? ` The user adds: "${query}".` : ''} Identify the exercise it is used for. Read any brand or placard text that names the exercise. If the machine supports several exercises, give the most common one.`
  : `The user did this exercise: "${query}".`}

${knownList.length ? `Exercises already in their log:\n${knownList.map(n => `- ${n}`).join('\n')}\nIf it is the same exercise as one of these (same movement and equipment), return that EXACT name so their history stays together.` : ''}

Otherwise use a standard gym name in Title Case with the equipment when it matters, e.g. "Incline Dumbbell Press", "Lat Pulldown", "Seated Cable Row", "Leg Press", "Barbell Back Squat", "Pec Deck Fly". No brand names, sets, reps or weights in the name.

Return ONLY raw JSON, no markdown:
{"name":"...","muscle_group":"one of: Chest, Back, Shoulders, Biceps, Triceps, Legs, Glutes, Core, Full Body","equipment":"Machine | Cable | Barbell | Dumbbell | Bodyweight | Kettlebell | Other","note":"one short sentence on how you identified it"}`;

    const content = imageData
      ? [{ type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: imageData } }, { type: 'text', text: instructions }]
      : instructions;

    const res = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 300, messages: [{ role: 'user', content }] }),
    });
    if (!res.ok) return json(500, { error: `API error ${res.status}: ${(await res.text()).slice(0, 200)}` });

    const data = await res.json();
    const raw = (data.content || []).map(b => b.text || '').join('').trim();
    const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
    if (s === -1) return json(500, { error: 'Could not identify that — try describing it' });
    const parsed = JSON.parse(raw.slice(s, e + 1));
    if (!parsed.name) return json(500, { error: 'Could not identify that — try describing it' });

    // Snap to an existing name when the model returned it with different casing/spacing
    const norm = t => String(t).toLowerCase().replace(/[^a-z0-9]/g, '');
    const match = knownList.find(k => norm(k) === norm(parsed.name));
    if (match) parsed.name = match;

    return json(200, {
      name: String(parsed.name).slice(0, 80),
      muscle_group: parsed.muscle_group || '',
      equipment: parsed.equipment || '',
      note: parsed.note || '',
    });
  } catch (e) {
    return json(500, { error: e.name === 'AbortError' ? 'Request timed out — try again' : e.message });
  }
};
