async function fetchWithTimeout(url, options, ms = 20000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(id);
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { query, excludeSource } = JSON.parse(event.body || '{}');
    if (!query) return { statusCode: 400, body: JSON.stringify({ error: 'Missing query' }) };

    const excludeClause = excludeSource
      ? `\nIMPORTANT: Do NOT use "${excludeSource}" as your source this time. Find a different source.`
      : '';

    const prompt = `You are a nutrition database. The user logged: "${query}"${excludeClause}

Source priority:
1. Named brand/restaurant → use their official published nutrition facts
2. No brand → use USDA FoodData Central
3. Unknown → estimate and say so

CRITICAL: Return ONLY this exact JSON with no text before or after it, no markdown, no commentary:
{"name":"food name max 80 chars","serving_size":"serving description","note":"source used","calories":0,"protein_g":0,"carbs_g":0,"fat_g":0,"sat_fat_g":0,"sugar_g":0,"sodium_mg":0,"fiber_g":0}

Rules:
- Keep name under 80 characters
- Round all numbers to nearest integer
- No apostrophes or quotes inside string values
- Output ONLY the JSON object, nothing else`;

    const res = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
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
      return { statusCode: 500, body: JSON.stringify({ error: `API error ${res.status}: ${err}` }) };
    }

    const data = await res.json();
    const raw = (data.content || []).map(b => b.text || '').join('').trim();

    // Extract JSON robustly — handles trailing commentary, markdown fences, etc.
    const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
    if (s === -1) return { statusCode: 500, body: JSON.stringify({ error: 'No JSON in response', raw: raw.slice(0, 300) }) };

    const parsed = JSON.parse(raw.slice(s, e + 1));
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(parsed)
    };
  } catch(e) {
    const msg = e.name === 'AbortError' ? 'Request timed out — try again' : e.message;
    return { statusCode: 500, body: JSON.stringify({ error: msg }) };
  }
};
