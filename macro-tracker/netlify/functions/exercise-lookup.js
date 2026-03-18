exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const { query } = JSON.parse(event.body || '{}');
  if (!query) return { statusCode: 400, body: 'Missing query' };

  const prompt = `You are a fitness and exercise calorie database. The user wants to log this workout: "${query}"

Return ONLY a raw JSON object, no markdown, no explanation, just JSON:
{"name":"descriptive exercise name with duration","calories_burned":0,"note":"source or method, e.g. MET value 8.0 for running, 70kg assumed if no weight given"}

Use MET (Metabolic Equivalent of Task) values from ACSM or Compendium of Physical Activities. 
Calculate calories as: MET × weight_kg × duration_hours × 1.05
If weight not specified, assume 80kg (176 lbs) as a reasonable average.
If duration not specified, assume 30 minutes.
Round calories_burned to nearest integer.
In the note field, state the MET value used, assumed weight if not provided, and assumed duration if not provided.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
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
