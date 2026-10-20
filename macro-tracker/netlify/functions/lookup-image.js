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

  const body = JSON.parse(event.body || '{}');
  const { mode, hint } = body;
  // One image (imageData) or several photos of the same package (images: [{ data, mediaType }])
  const images = Array.isArray(body.images) && body.images.length
    ? body.images.slice(0, 3).filter(im => im && im.data).map(im => ({ data: im.data, mediaType: im.mediaType || 'image/jpeg' }))
    : body.imageData ? [{ data: body.imageData, mediaType: body.mediaType || 'image/jpeg' }] : [];
  const userHint = String(hint || '').trim().slice(0, 200);
  if (!images.length) return { statusCode: 400, body: JSON.stringify({ error: 'Missing image data' }) };

  // Guard: base64 PNG screenshots can be large — reject if over 5MB encoded (all photos together)
  const approxBytes = images.reduce((a, im) => a + im.data.length, 0) * 0.75;
  if (approxBytes > 5 * 1024 * 1024) {
    return { statusCode: 413, body: JSON.stringify({ error: 'Image too large — try a smaller screenshot' }) };
  }

  // Barcode mode: just read the digits printed under the bars (fallback when the
  // phone couldn't decode the bars themselves)
  const prompt = mode === 'package' ? `These ${images.length} photo${images.length === 1 ? '' : 's'} all show ONE packaged food product (different sides: front, barcode, Nutrition Facts, ingredients).
Read everything that is visible and return ONLY a raw JSON array with exactly one object, no markdown:
[{"name":"brand + product name as printed on the package, or empty","barcode":"digits under the barcode if fully readable, else empty","serving_size":"as printed, e.g. 1 bar (60g), or empty","label":null,"ingredients":null,"nova":null,"additives":null}]
- "label": ONLY if a Nutrition Facts panel is visible, an object with the PER-SERVING values copied exactly: {"calories":0,"protein_g":0,"carbs_g":0,"fat_g":0,"sat_fat_g":0,"sugar_g":0,"sodium_mg":0,"fiber_g":0}. Otherwise null. Never estimate.
- "ingredients": ONLY if the ingredients list is visible, the text as printed. Otherwise null.
- "nova" and "additives": ONLY if the ingredients are visible. nova = NOVA group 1-4. additives = every additive as a short name with its E-number where one exists (e.g. "e955 sucralose", "e466 cellulose gum"). Otherwise null.
- Use only what you can read. Leave anything unreadable empty or null.` : mode === 'barcode' ? `This photo shows a product barcode (UPC/EAN). Read the digits printed beneath the bars, exactly, with no spaces.
Return ONLY a raw JSON array, no markdown: [{"barcode":"012345678905","name":"product name if visible, else empty"}]
If you cannot read every digit with confidence, return [{"barcode":""}].` : `You are a precise nutrition database. Analyze this image and identify ALL food and drink items shown.

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

${userHint ? `THE USER SAYS: "${userHint.replace(/[`$]/g, '')}"
- Return ONLY the item(s) they describe. Ignore everything else in the image (other menu items, other people's food, other receipt lines).
- If this is a menu or receipt, find the matching line and use its size/options; if the menu prints calories, use them.
- If what they describe isn't visible, return your best match and say so in "note".

` : ''}${mode === 'ingredients' ? `THIS IMAGE SHOWS A PACKAGE'S INGREDIENTS LIST (the user chose "Ingredients").
- Return exactly ONE item: the product.
- "nova" and "additives" are REQUIRED here: classify processing from the ingredients and list every additive (E-numbers where they exist).
- If a Nutrition Facts panel is also visible, copy its per-serving numbers; otherwise set the nutrition numbers to null.
- note = "Ingredients photo".

` : ''}${mode === 'label' ? `THIS IMAGE IS A NUTRITION FACTS LABEL (the user chose "Nutrition label").
- Return exactly ONE item: the packaged product, per ONE serving as printed on the label.
- Copy every number exactly as printed: calories, protein, total carbohydrate, total fat, saturated fat, total sugars, sodium, dietary fiber.
- serving_size = the label's serving size text (e.g. "3/4 cup (52g)").
- name = the brand and product name if visible anywhere in the photo; otherwise "Packaged food (label)".
- note = "Nutrition label".

` : ''}Return ONLY a raw JSON array, no markdown, no explanation:
[{"name":"exact item name with size/quantity","category":"entree|side|drink|other","serving_size":"description of one serving","note":"source used","calories":0,"protein_g":0,"carbs_g":0,"fat_g":0,"sat_fat_g":0,"sugar_g":0,"sodium_mg":0,"fiber_g":0,"nova":null,"additives":null}]

Rules:
- ALWAYS return an array even if there is only one item
- Return one object per distinct food/drink item
- Round all numbers to nearest integer
- For custom build-your-own items (bowls, burritos), estimate the full assembled item as one entry
- Do not split toppings/dressings unless they appear as explicitly separate line items on a receipt
- "nova" and "additives" (for a food-quality score): if an INGREDIENTS list is visible, set "nova" to its NOVA group (1 unprocessed, 2 culinary ingredient, 3 processed, 4 ultra-processed) and list its additives as short names with E-numbers where they exist (e.g. "e955 sucralose", "red 40"). A plainly whole food (fruit, eggs, plain grilled meat) is nova 1 with additives []. Otherwise leave both null — never guess.`;

  // Models get retired over time (this is what broke photo lookups), so try the
  // newest first and fall back if one is no longer available (404).
  const MODELS = ['claude-sonnet-5-5', 'claude-sonnet-4-5', 'claude-haiku-4-5-20251001'];
  let res;
  for (const model of MODELS) {
    res = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model,
        max_tokens: 3000,
        messages: [{
          role: 'user',
          content: [
            ...images.map(im => ({ type: 'image', source: { type: 'base64', media_type: im.mediaType, data: im.data } })),
            { type: 'text', text: prompt }
          ]
        }]
      })
    });
    if (res.status !== 404) break;
  }

  if (!res.ok) {
    const err = await res.text();
    return { statusCode: 500, body: JSON.stringify({ error: `API error ${res.status}: ${err}` }) };
  }

  const data = await res.json();
  const raw = (data.content || []).map(b => b.text || '').join('').trim();

  // Pull every COMPLETE {...} object out of text, even if the answer was cut off
  // before its closing bracket (strings and nested objects handled)
  function completeObjects(text) {
    const out = []; let depth = 0, start = -1, inStr = false, esc = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '{') { if (depth === 0) start = i; depth++; }
      else if (c === '}' && depth > 0) { depth--; if (depth === 0 && start >= 0) { try { out.push(JSON.parse(text.slice(start, i + 1))); } catch (_) {} start = -1; } }
    }
    return out;
  }

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
    // Cut off mid-answer (or stray text)? Keep every item that finished
    const salvaged = completeObjects(raw).filter(o => o && (o.name || o.barcode || o.calories != null || o.label));
    if (salvaged.length) parsed = salvaged;
    else {
      const msg = e.name === 'AbortError' ? 'Request timed out — try again'
        : data.stop_reason === 'max_tokens' ? 'Too many items in one photo — try a closer shot, or describe what to look for' : `Couldn't read the result — try again`;
      return { statusCode: 500, body: JSON.stringify({ error: msg }) };
    }
  }

  // Ensure result is always an array
  if (!Array.isArray(parsed)) parsed = [parsed];

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(parsed)
  };
};
