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
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  const { imageData, mediaType } = JSON.parse(event.body || '{}');
  if (!imageData) return { statusCode: 400, body: JSON.stringify({ error: 'Missing image data' }) };

  // Guard: base64 PNG screenshots can be large — reject if over 5MB encoded
  const approxBytes = imageData.length * 0.75;
  if (approxBytes > 5 * 1024 * 1024) {
    return { statusCode: 413, body: JSON.stringify({ error: 'Image too large — try a smaller screenshot' }) };
  }

  const prompt = `You are a precise nutrition database. Analyze this image and identify ALL food and drink items shown.

The image may contain: a nutrition label, a restaurant order receipt/confirmation, a menu screenshot, a plate of food, or packaged products.

CATEGORIZATION RULES:
- "entree": main dish, primary protein source, or any item that is the focal point of a meal (bowls, sandwiches, burgers, pasta, wraps, salads as mains)
- "side": smaller accompaniment (chips, fries, soup, bread, fruit cup, small salad)
- "drink": any beverage including smoothies, juices, sodas, protein shakes
- "other": sauces, dressings, toppings, or extras logged separately

DATA SOURCE PRIORITY:
1. If a specific brand/restaurant is visible → use their published nutrition data
2. If a nutrition label is shown → read exact values from the label
3. Otherwise → estimate based on visible ingredients and portions

Return ONLY a raw JSON array, no markdown, no explanation:
[{"name":"exact item name with size/quantity","category":"entree|side|drink|other","serving_size":"description of one serving","note":"source used","calories":0,"protein_g":0,"carbs_g":0,"fat_g":0,"sat_fat_g":0,"sugar_g":0,"sodium_mg":0,"fiber_g":0}]

Rules:
- ALWAYS return an array even if there is only one item
- Return one object per distinct food/drink item
- Round all numbers to nearest integer
- For custom build-your-own items (bowls, burritos), estimate the full assembled item as one entry
- Do not split toppings/dressings unless they appear as explicitly separate line items on a receipt`;

  const res = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1500,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: imageData } },
          { type: 'text', text: prompt }
        ]
      }]
    })
  });

  if (!res.ok) {
    const err = await res.text();
    return { statusCode: 500, body: JSON.stringify({ error: `API error ${res.status}: ${err}` }) };
  }

  const data = await res.json();
  const raw = (data.content || []).map(b => b.text || '').join('').trim();

  // Try array first, fall back to single object wrapped in array
  let parsed;
  const arrStart = raw.indexOf('[');
  const objStart = raw.indexOf('{');

  try {
    if (arrStart !== -1 && (objStart === -1 || arrStart < objStart)) {
      // Looks like an array
      const e = raw.lastIndexOf(']');
      parsed = JSON.parse(raw.slice(arrStart, e + 1));
    } else if (objStart !== -1) {
      // Model returned a single object — wrap it
      const e = raw.lastIndexOf('}');
      parsed = [JSON.parse(raw.slice(objStart, e + 1))];
    } else {
      return { statusCode: 500, body: JSON.stringify({ error: 'No JSON in response' }) };
    }
  } catch(e) {
    const msg = e.name === 'AbortError' ? 'Request timed out — try again' : `JSON parse error: ${e.message}`;
    return { statusCode: 500, body: JSON.stringify({ error: msg }) };
  }

  // Ensure result is always an array
  if (!Array.isArray(parsed)) parsed = [parsed];

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(parsed)
  };
};
