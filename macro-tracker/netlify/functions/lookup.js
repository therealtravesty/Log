exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const { query, excludeSource } = JSON.parse(event.body || '{}');
  if (!query) return { statusCode: 400, body: 'Missing query' };

  const excludeClause = excludeSource
    ? `\nIMPORTANT: Do NOT use "${excludeSource}" as your source this time. Use a different nutrition database or source.`
    : '';

  const prompt = `You are a precise nutrition database. The user wants to log: "${query}"${excludeClause}

Return ONLY a raw JSON object, no markdown, no explanation, just JSON:
{"name":"descriptive food name with portion","note":"source: e.g. USDA FoodData Central, McDonald's nutrition info, generic estimate — be specific","calories":0,"protein_g":0,"carbs_g":0,"fat_g":0,"sat_fat_g":0,"sugar_g":0,"sodium_mg":0,"fiber_g":0}

Use USDA or official restaurant/brand nutrition values where known. Round all numbers to nearest integer. If portion unspecified, assume standard single serving and note it. In the note field, always state the specific source (e.g. "USDA FoodData Central", "McDonald's official nutrition", "generic estimate — verify with label") and any key assumptions made.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  if (!res.ok) {
    const err = await res.text();
    return { statusCode: 500, body: JSON.stringify({ error: err }) };
  }

  const data = await res.json();
  const raw = (data.content || []).map(b => b.text || '').join('').trim();
  const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
  if (s === -1) return { statusCode: 500, body: JSON.stringify({ error: 'No JSON in response' }) };

  const parsed = JSON.parse(raw.slice(s, e + 1));

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(parsed)
  };
};
