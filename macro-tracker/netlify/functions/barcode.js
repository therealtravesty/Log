// netlify/functions/barcode.js
//
// GET /api/barcode?code=0123456789012
//
// Barcode → the most official product data available:
//   1. USDA FoodData Central, searched by UPC: manufacturer-supplied brand label
//      data (official name, real serving size, nutrition, ingredients)
//   2. Open Food Facts, in parallel: processing level (NOVA), additives,
//      Nutri-Score, ingredients — the quality-score inputs
//   3. If USDA doesn't have it: the multi-source web lookup (/api/lookup) with
//      Open Food Facts' brand + name + the UPC, to find the official product
//      page (fixes crowd-sourced names like "Or gain" and per-100g-only data)
//   4. Open Food Facts alone, tidied, as a last resort
// Same response shape as /api/lookup, plus quality + found.
//
// Env: USDA_API_KEY (also used by lookup), ANTHROPIC_API_KEY (for step 3)

const USDA_KEY = process.env.USDA_API_KEY;
const json = (statusCode, body) => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const r0 = n => (n == null || isNaN(n) ? null : Math.round(Number(n)));
const r1 = n => (n == null || isNaN(n) ? null : Math.round(Number(n) * 10) / 10);

async function fetchT(url, opts = {}, ms = 5000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctl.signal }); } finally { clearTimeout(t); }
}
// "ORGAIN" → "Orgain", "PROTEIN SHAKE, VANILLA" → "Protein Shake, Vanilla"
const tidy = s => String(s || '').trim().toLowerCase().replace(/(^|[\s\-/(&])([a-z])/g, (m, p, c) => p + c.toUpperCase()).replace(/\b(Oz|Fl|Ml|G)\b/g, m => m.toLowerCase());
// UPCs are stored with or without leading zeros (UPC-A 12 vs EAN-13 13 digits)
const sameUpc = (a, b) => String(a || '').replace(/^0+/, '') === String(b || '').replace(/^0+/, '');

async function usdaByUpc(code) {
  if (!USDA_KEY) return null;
  try {
    const res = await fetchT(`https://api.nal.usda.gov/fdc/v1/foods/search?api_key=${encodeURIComponent(USDA_KEY)}&query=${code}&dataType=Branded&pageSize=5`);
    if (!res.ok) return null;
    const f = ((await res.json()).foods || []).find(x => sameUpc(x.gtinUpc, code));
    if (!f) return null;
    const n = num => (f.foodNutrients || []).find(x => String(x.nutrientNumber) === num && (num !== '208' || /kcal/i.test(x.unitName || '')))?.value;
    // Search values are per 100 g/ml; scale to the label serving
    const unit = String(f.servingSizeUnit || '').toLowerCase();
    const k = f.servingSize && /^(g|ml|grm|mlt)$/.test(unit) ? f.servingSize / 100 : null;
    if (!k || n('208') == null) return null;
    const brand = tidy(f.brandName || f.brandOwner || '');
    const desc = tidy(f.description || '');
    return {
      // "Orgain, Clean Protein, Plant Based Protein Shake, Vanilla Bean" → "Orgain Clean Protein Plant Based Protein Shake, Vanilla Bean"
      name: (desc.toLowerCase().startsWith(brand.toLowerCase()) ? desc : `${brand} ${desc}`).replace(/^([^,]+),\s*([^,]+),\s*/, '$1 $2 ').replace(/\s+/g, ' ').trim().slice(0, 120),
      serving_size: `${f.householdServingFullText ? tidy(f.householdServingFullText) + ' ' : ''}(${r0(f.servingSize)}${unit.replace('grm', 'g').replace('mlt', 'ml')})`,
      calories: r0(n('208') * k), protein_g: r1(n('203') * k), carbs_g: r1(n('205') * k), fat_g: r1(n('204') * k),
      sat_fat_g: r1((n('606') || 0) * k), sugar_g: r1((n('269') || 0) * k), sodium_mg: r0((n('307') || 0) * k), fiber_g: r1((n('291') || 0) * k),
      ingredients: String(f.ingredients || '').slice(0, 600),
      source: 'USDA (manufacturer label data)', source_url: `https://fdc.nal.usda.gov/food-details/${f.fdcId}/nutrients`,
    };
  } catch (_) { return null; }
}

async function offByCode(code) {
  try {
    const fields = 'code,product_name,brands,serving_size,serving_quantity,nutriments,nutriscore_grade,nova_group,additives_tags,labels_tags,ingredients_text_en,ingredients_text';
    const res = await fetchT(`https://world.openfoodfacts.org/api/v2/product/${code}?fields=${fields}`, { headers: { 'User-Agent': 'Log-nutrition-app/1.0 (personal use)' } });
    if (!res.ok) return null;
    const data = await res.json();
    const p = data.product;
    if (!data.status || !p) return null;
    const nm = p.nutriments || {};
    const hasServing = nm['energy-kcal_serving'] != null;
    const k = hasServing ? 1 : (p.serving_quantity ? Number(p.serving_quantity) / 100 : null);
    const v = key => { const x = nm[`${key}_${hasServing ? 'serving' : '100g'}`]; return x == null ? null : x * (k || 1); };
    return {
      name: [tidy(p.brands && p.brands.split(',')[0]), tidy(p.product_name)].filter(Boolean).join(' ').slice(0, 120),
      brand: tidy(p.brands && p.brands.split(',')[0]), productName: p.product_name || '',
      perServing: hasServing || !!k,
      serving_size: hasServing || k ? (p.serving_size || `${r0(p.serving_quantity)} g`) : '100 g',
      calories: r0(v('energy-kcal')), protein_g: r1(v('proteins')), carbs_g: r1(v('carbohydrates')), fat_g: r1(v('fat')),
      sat_fat_g: r1(v('saturated-fat')), sugar_g: r1(v('sugars')), sodium_mg: v('sodium') != null ? r0(v('sodium') * 1000) : null, fiber_g: r1(v('fiber')),
      quality: {
        nova: [1, 2, 3, 4].includes(Number(p.nova_group)) ? Number(p.nova_group) : null,
        additives: (p.additives_tags || []).length ? p.additives_tags.map(a => String(a).replace(/^en:/, '')).slice(0, 40) : null,
        nutriscore: /^[a-e]$/.test(p.nutriscore_grade || '') ? p.nutriscore_grade : null,
        organic: (p.labels_tags || []).some(l => /organic|bio/.test(l)),
        ingredients: String(p.ingredients_text_en || p.ingredients_text || '').slice(0, 600),
        source: 'Open Food Facts',
      },
      url: `https://world.openfoodfacts.org/product/${code}`,
    };
  } catch (_) { return null; }
}

exports.handler = async (event) => {
  const code = String((event.queryStringParameters || {}).code || '').replace(/\D/g, '');
  if (code.length < 6 || code.length > 14) return json(400, { error: 'Enter a valid barcode' });

  const [usda, off] = await Promise.all([usdaByUpc(code), offByCode(code)]);
  // Quality inputs: Open Food Facts first; else USDA's ingredient list (the app
  // spots known additives in it)
  const quality = off?.quality?.nova || off?.quality?.additives ? off.quality
    : (usda?.ingredients || off?.quality?.ingredients) ? { nova: null, additives: null, ingredients: usda?.ingredients || off.quality.ingredients, source: usda?.ingredients ? 'USDA' : 'Open Food Facts' } : null;
  const checked = [USDA_KEY ? 'USDA' : null, 'Open Food Facts'].filter(Boolean);

  // 1. USDA manufacturer data
  if (usda) {
    return json(200, { found: true, code, ...usda, confidence: 'high', quality, sources_checked: checked,
      note: off?.name && off.name.toLowerCase() !== usda.name.toLowerCase() ? `Official name (Open Food Facts lists it as "${off.name}")` : 'Manufacturer label data' });
  }

  // 2. Not in USDA: find the official product page on the web
  if (off?.name || off?.productName) {
    try {
      const lookup = require('./lookup');
      const res = await lookup.handler({ httpMethod: 'POST', body: JSON.stringify({
        query: `1 serving of ${off.name} (UPC ${code}). Use the brand's official product name and the label's serving size.` }) });
      const d = JSON.parse(res.body || '{}');
      if (res.statusCode === 200 && d.calories != null && d.source_url && d.confidence !== 'low') {
        return json(200, { found: true, code, ...d, quality: quality || d.quality || null, sources_checked: [...checked, 'Web search'],
          note: `Official product page${off.name && d.name && off.name.toLowerCase() !== d.name.toLowerCase() ? ` (Open Food Facts lists it as "${off.name}")` : ''}` });
      }
    } catch (_) { /* fall through to Open Food Facts */ }
  }

  // 3. Open Food Facts only
  if (!off) return json(200, { found: false, code });
  if (off.calories == null) return json(200, { found: true, code, name: off.name, incomplete: true });
  return json(200, { found: true, code, name: off.name, serving_size: off.serving_size,
    calories: off.calories, protein_g: off.protein_g, carbs_g: off.carbs_g, fat_g: off.fat_g,
    sat_fat_g: off.sat_fat_g, sugar_g: off.sugar_g, sodium_mg: off.sodium_mg, fiber_g: off.fiber_g,
    source: 'Open Food Facts', source_url: off.url, confidence: off.perServing ? 'medium' : 'low', quality, sources_checked: checked,
    note: off.perServing ? 'Crowd-sourced data' : 'Per 100 g, this product has no serving size listed; check the package' });
};
