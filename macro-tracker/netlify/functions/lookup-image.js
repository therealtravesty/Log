exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  const { imageData, mediaType } = JSON.parse(event.body || '{}');
  if (!imageData) return { statusCode: 400, body: JSON.stringify({ error: 'Missing image data' }) };

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
- Return one object per distinct food/drink item
- If only one item is visible, still return an array with one element
- Round all numbers to nearest integer
- For custom build-your-own items (bowls, burritos), estimate the full assembled item as one entry
- Do not split toppings/dressings into separate entries unless they appear as explicitly separate line items on a receipt`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
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
    return { statusCode: 500, body: JSON.stringify({ error: err }) };
  }

  const data = await res.json();
  const raw = (data.content || []).map(b => b.text || '').join('').trim();
  const s = raw.indexOf('['), e = raw.lastIndexOf(']');
  if (s === -1) return { statusCode: 500, body: JSON.stringify({ error: 'No JSON in response' }) };

  const parsed = JSON.parse(raw.slice(s, e + 1));
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(parsed)
  };
};
