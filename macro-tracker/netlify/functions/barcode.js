// netlify/functions/barcode.js
//
// GET /api/barcode?code=0123456789012
//
// Looks up a packaged product by barcode in Open Food Facts (free, open data)
// and returns the same shape as /api/lookup: per-serving nutrition, plus the
// quality data used for Lōg's score — processing level (NOVA 1–4), additives,
// Nutri-Score, organic — and the ingredient list.
// { found: false } if the product isn't in Open Food Facts.

const json = (statusCode, body) => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const r0 = n => (n == null || isNaN(n) ? null : Math.round(Number(n)));
const r1 = n => (n == null || isNaN(n) ? null : Math.round(Number(n) * 10) / 10);

exports.handler = async (event) => {
  const code = String((event.queryStringParameters || {}).code || '').replace(/\D/g, '');
  if (code.length < 6 || code.length > 14) return json(400, { error: 'Enter a valid barcode' });
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 8000);
    const fields = 'code,product_name,brands,serving_size,serving_quantity,nutriments,nutriscore_grade,nova_group,additives_tags,labels_tags,ingredients_text_en,ingredients_text';
    const res = await fetch(`https://world.openfoodfacts.org/api/v2/product/${code}?fields=${fields}`, {
      headers: { 'User-Agent': 'Log-nutrition-app/1.0 (personal use)' }, signal: ctl.signal,
    });
    clearTimeout(t);
    if (res.status === 404) return json(200, { found: false, code });
    if (!res.ok) return json(502, { error: `Open Food Facts error ${res.status}` });
    const data = await res.json();
    const p = data.product;
    if (!data.status || !p) return json(200, { found: false, code });

    const nm = p.nutriments || {};
    // Per serving when the product lists it; otherwise scale per-100g by the serving size
    const hasServing = nm['energy-kcal_serving'] != null;
    const k = hasServing ? 1 : (p.serving_quantity ? Number(p.serving_quantity) / 100 : 1);
    const v = key => { const x = nm[`${key}_${hasServing ? 'serving' : '100g'}`]; return x == null ? null : x * k; };
    const servingLabel = hasServing || p.serving_quantity ? (p.serving_size || `${r0(p.serving_quantity)} g`) : '100 g';
    const name = [p.brands && p.brands.split(',')[0].trim(), p.product_name].filter(Boolean).join(' ').slice(0, 120);
    if (v('energy-kcal') == null) return json(200, { found: true, code, name, incomplete: true });

    return json(200, {
      found: true, code, name,
      serving_size: servingLabel,
      calories: r0(v('energy-kcal')), protein_g: r1(v('proteins')), carbs_g: r1(v('carbohydrates')), fat_g: r1(v('fat')),
      sat_fat_g: r1(v('saturated-fat')), sugar_g: r1(v('sugars')), sodium_mg: v('sodium') != null ? r0(v('sodium') * 1000) : null, fiber_g: r1(v('fiber')),
      source: 'Open Food Facts', source_url: `https://world.openfoodfacts.org/product/${code}`, confidence: 'high',
      quality: {
        nova: [1, 2, 3, 4].includes(Number(p.nova_group)) ? Number(p.nova_group) : null,
        additives: (p.additives_tags || []).map(a => String(a).replace(/^en:/, '')).slice(0, 40),
        nutriscore: /^[a-e]$/.test(p.nutriscore_grade || '') ? p.nutriscore_grade : null,
        organic: (p.labels_tags || []).some(l => /organic|bio/.test(l)),
        ingredients: String(p.ingredients_text_en || p.ingredients_text || '').slice(0, 600),
        source: 'Open Food Facts',
      },
    });
  } catch (e) {
    return json(500, { error: e.name === 'AbortError' ? 'Open Food Facts timed out — try again' : e.message });
  }
};
