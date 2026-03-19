// Fetch with explicit timeout to prevent hanging until Netlify kills the function
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

    const prompt = `You are a precise nutrition database assistant. The user wants to log: "${query}"${excludeClause}

Follow this exact priority order when sourcing nutrition data:
1. EXACT BRAND MATCH: If the query names a specific brand or product (e.g. "Chobani Greek yogurt", "Quest protein bar"), use that brand's official published nutrition facts. State the exact product name and brand.
2. GENERIC BRANDED ITEM: If no exact product match, use the most common version of that branded product category.
3. USDA / DATABASE ESTIMATE: If no brand is mentioned or identifiable, use USDA FoodData Central or a reputable nutrition database.
4. REASONABLE ESTIMATE: Only if nothing else works, estimate based on similar items and clearly state "estimated based on similar items".

Return ONLY a raw JSON object — no markdown, no explanation:
{"name":"exact product name or descriptive name with quantity","serving_size":"e.g. 1 cup (240ml), 1 bar (60g)","note":"source: [exact source used]","calories":0,"protein_g":0,"carbs_g":0,"fat_g":0,"sat_fat_g":0,"sugar_g":0,"sodium_mg":0,"fiber_g":0}

Round all numbers to nearest integer. Be as specific as possible about the source.`;

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
    const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
    if (s === -1) return { statusCode: 500, body: JSON.stringify({ error: 'No JSON in response', raw: raw.slice(0, 200) }) };

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
