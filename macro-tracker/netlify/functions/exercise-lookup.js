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
    const { query, weightKg } = JSON.parse(event.body || '{}');
    if (!query) return { statusCode: 400, body: JSON.stringify({ error: 'Missing query' }) };
    const kg = weightKg || 83;

    const prompt = `You are a fitness and exercise calorie database. The user wants to log this workout: "${query}"

Return ONLY a raw JSON object, no markdown, no explanation, just JSON:
{"name":"descriptive exercise name with duration","calories_burned":0,"note":"source or method, e.g. MET value 8.0 for running, 70kg assumed if no weight given"}

Use MET (Metabolic Equivalent of Task) values from ACSM or Compendium of Physical Activities.
Calculate calories as: MET × weight_kg × duration_hours × 1.05
User's actual body weight: ${kg}kg — use this exact value for calorie calculations, do not assume a default weight.
If duration not specified, assume 30 minutes.
Round calories_burned to nearest integer.
In the note field, state the MET value used, the body weight used, and assumed duration if not provided.`;

    const res = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!res.ok) {
      const err = await res.text();
      return { statusCode: 500, body: JSON.stringify({ error: `API error ${res.status}: ${err}` }) };
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
  } catch(e) {
    const msg = e.name === 'AbortError' ? 'Request timed out — try again' : e.message;
    return { statusCode: 500, body: JSON.stringify({ error: msg }) };
  }
};
