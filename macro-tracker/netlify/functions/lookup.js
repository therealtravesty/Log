// netlify/functions/lookup.js
//
// POST /api/lookup  { query, excludeSource?, references? }
//
// Multi-source nutrition lookup. Instead of asking a model to remember
// numbers (which fails for newer products — e.g. David bars came back as
// 200 kcal / 10g protein instead of the label's 150 / 28), this:
//   1. searches USDA FoodData Central and Open Food Facts in parallel
//   2. gives Claude those candidates AND a web search tool, so it can read
//      the brand's own page / label for packaged and restaurant items
//   3. returns the best match with its source + link, a confidence level,
//      and up to 3 alternatives (other versions or other sources)
//
// Response keeps the old fields (name, calories, protein_g, …, serving_size,
// note) so older app versions still work, plus: source, source_url,
// confidence, alternatives[], sources_checked[].
//
// Timing: databases 4s (parallel) + Claude 20s stays inside Netlify's 26s limit.
// Env: ANTHROPIC_API_KEY, USDA_API_KEY (free from api.data.gov; optional —
// without it USDA is skipped).

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const USDA_KEY = process.env.USDA_API_KEY;
// Newest first; fall back if a model has been retired (404)
const MODELS = ['claude-sonnet-5-5', 'claude-sonnet-4-5', 'claude-haiku-4-5-20251001'];

const json = (statusCode, body) => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function fetchWithTimeout(url, options = {}, ms = 20000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(id); }
}
const r0 = n => (n == null || isNaN(n) ? null : Math.round(Number(n)));
const r1 = n => (n == null || isNaN(n) ? null : Math.round(Number(n) * 10) / 10);

// "2 bananas" → "bananas"; databases search better without quantities
function searchTerms(q) {
  return String(q || '').replace(/^\s*(\d+(\.\d+)?|\d+\/\d+|a|an|one|two|half)\s+(x\s+)?/i, '').trim().slice(0, 100);
}

// ── USDA FoodData Central (generic foods + US branded label data) ──
async function usdaSearch(q) {
  if (!USDA_KEY || !q) return [];
  try {
    const url = `https://api.nal.usda.gov/fdc/v1/foods/search?api_key=${encodeURIComponent(USDA_KEY)}&query=${encodeURIComponent(q)}&pageSize=5&dataType=${encodeURIComponent('Branded,Foundation,SR Legacy,Survey (FNDDS)')}`;
    const res = await fetchWithTimeout(url, {}, 4000);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.foods || []).slice(0, 5).map(f => {
      const n = num => (f.foodNutrients || []).find(x => String(x.nutrientNumber) === num && (num !== '208' || /kcal/i.test(x.unitName || '')))?.value;
      // Search values are per 100 g; scale to the label serving when it's in g/ml
      const perServing = f.servingSize && /^(g|ml|grm|mlt)$/i.test(f.servingSizeUnit || '') ? f.servingSize / 100 : null;
      const k = perServing || 1;
      const serving = perServing
        ? `${f.householdServingFullText ? f.householdServingFullText + ' ' : ''}(${r0(f.servingSize)}${(f.servingSizeUnit || 'g').toLowerCase().replace('grm', 'g').replace('mlt', 'ml')})`
        : '100 g';
      return {
        source: 'USDA FoodData Central' + (f.dataType === 'Branded' ? ' (brand label data)' : ''),
        url: `https://fdc.nal.usda.gov/food-details/${f.fdcId}/nutrients`,
        name: [f.brandName || f.brandOwner, f.description].filter(Boolean).join(' — ').slice(0, 120),
        serving,
        calories: r0(n('208') * k), protein_g: r1(n('203') * k), carbs_g: r1(n('205') * k), fat_g: r1(n('204') * k),
        sat_fat_g: r1(n('606') * k), sugar_g: r1(n('269') * k), sodium_mg: r0(n('307') * k), fiber_g: r1(n('291') * k),
      };
    }).filter(c => c.calories != null);
  } catch (_) { return []; }
}

// ── Open Food Facts (crowd-sourced packaged-food labels) ──
async function offSearch(q) {
  if (!q) return [];
  try {
    const url = `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(q)}&search_simple=1&action=process&json=1&page_size=5&fields=code,product_name,brands,serving_size,nutriments`;
    const res = await fetchWithTimeout(url, { headers: { 'User-Agent': 'Log-nutrition-app/1.0 (personal use)' } }, 4000);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.products || []).slice(0, 5).map(p => {
      const nm = p.nutriments || {};
      const hasServing = nm['energy-kcal_serving'] != null;
      const v = key => nm[`${key}_${hasServing ? 'serving' : '100g'}`];
      return {
        source: 'Open Food Facts',
        url: p.code ? `https://world.openfoodfacts.org/product/${p.code}` : '',
        name: [p.brands, p.product_name].filter(Boolean).join(' — ').slice(0, 120),
        serving: hasServing ? (p.serving_size || '1 serving') : '100 g',
        calories: r0(v('energy-kcal')), protein_g: r1(v('proteins')), carbs_g: r1(v('carbohydrates')), fat_g: r1(v('fat')),
        sat_fat_g: r1(v('saturated-fat')), sugar_g: r1(v('sugars')), sodium_mg: v('sodium') != null ? r0(v('sodium') * 1000) : null, fiber_g: r1(v('fiber')),
      };
    }).filter(c => c.calories != null && c.name);
  } catch (_) { return []; }
}

function extractJson(raw) {
  // The answer may follow search narration; take the last {"name"... object
  let start = raw.lastIndexOf('{"name"');
  if (start === -1) start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(raw.slice(start, end + 1)); } catch (_) {}
  try { return JSON.parse(raw.slice(raw.indexOf('{'), end + 1)); } catch (_) { return null; }
}

async function askClaude(prompt, useWeb) {
  let lastErr = '';
  for (const model of MODELS) {
    const body = { model, max_tokens: 1800, messages: [{ role: 'user', content: prompt }] };
    if (useWeb) body.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }];
    const res = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body),
    }, 20000);
    if (res.ok) return { data: await res.json(), model };
    lastErr = `${res.status}: ${(await res.text()).slice(0, 300)}`;
    if (res.status === 404) continue;                 // model retired → next
    if (useWeb && res.status === 400 && /web_search|tool/i.test(lastErr)) return { webUnavailable: true, err: lastErr };
    break;
  }
  return { err: lastErr };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  if (!ANTHROPIC_KEY) return json(500, { error: 'ANTHROPIC_API_KEY not configured' });

  try {
    const { query, excludeSource, references } = JSON.parse(event.body || '{}');
    if (!query || !String(query).trim()) return json(400, { error: 'query required' });
    const q = String(query).trim().slice(0, 300);
    const terms = searchTerms(q);

    // 1. Databases in parallel
    const [usda, off] = await Promise.all([usdaSearch(terms), offSearch(terms)]);
    const candidates = [...usda, ...off];
    const checked = [USDA_KEY ? 'USDA FoodData Central' : null, 'Open Food Facts'].filter(Boolean);

    const refs = Array.isArray(references) ? references.slice(0, 5).filter(r => r && r.name) : [];
    const prompt = `You are a careful nutrition researcher. The user logged: "${q}"

DATABASE CANDIDATES (per the serving listed; may or may not be the right product):
${candidates.length ? candidates.map((c, i) => `${i + 1}. [${c.source}] ${c.name} — ${c.serving}: ${c.calories} kcal, ${c.protein_g}g protein, ${c.carbs_g}g carbs, ${c.fat_g}g fat, ${c.sugar_g ?? '?'}g sugar, ${c.sodium_mg ?? '?'}mg sodium, ${c.fiber_g ?? '?'}g fiber. URL: ${c.url}`).join('\n') : '(none found)'}
${refs.length ? `
VERIFIED FOODS THIS USER HAS LOGGED BEFORE (per serving):
${refs.map(r => `- ${String(r.name).slice(0, 80)} (${String(r.serving || '1 serving').slice(0, 40)}): ${Math.round(r.cal)} kcal, ${Math.round(r.pro)}g protein`).join('\n')}
Same-line variants are usually close; treat a big gap as a reason to double-check.` : ''}${excludeSource ? `\nThe user rejected the source "${String(excludeSource).slice(0, 80)}". Use a different source.` : ''}

HOW TO ANSWER:
- Branded, packaged, or restaurant items: unless a database candidate is clearly the exact product, use web search to find the brand's official nutrition page or label. Never rely on memory alone for brands.
- Generic whole foods (eggs, banana, chicken breast): prefer USDA. Search only if no candidate fits.
- Source priority: brand/manufacturer > USDA brand label data > official restaurant info > Open Food Facts > other sites > your own estimate.
- If the product comes in several versions with different nutrition (product lines, sizes, recipes), put the most likely one first and list the others in "alternatives".
- Return values for the QUANTITY the user described (e.g. "2 bars" = two bars), with serving_size describing that quantity.
- source_url must be a page you actually read or a candidate URL. If you could not verify, leave it empty and set confidence "low".

Return ONLY this JSON (no markdown, no text after it):
{"name":"product name","serving_size":"e.g. 1 bar (62g)","calories":0,"protein_g":0,"carbs_g":0,"fat_g":0,"sat_fat_g":0,"sugar_g":0,"sodium_mg":0,"fiber_g":0,"source":"short source name","source_url":"https://…","confidence":"high|medium|low","note":"one short sentence, e.g. which version this is or why sources differ","alternatives":[{"name":"","serving_size":"","calories":0,"protein_g":0,"carbs_g":0,"fat_g":0,"sat_fat_g":0,"sugar_g":0,"sodium_mg":0,"fiber_g":0,"source":"","source_url":""}]}`;

    // 2. Claude with web search (falls back to no-web if the org hasn't enabled it)
    let out = await askClaude(prompt, true), usedWeb = true;
    if (out.webUnavailable) { usedWeb = false; out = await askClaude(prompt, false); }
    if (out.err && !out.data) return json(500, { error: `Lookup failed (${out.err})` });

    const blocks = out.data.content || [];
    const raw = blocks.filter(b => b.type === 'text').map(b => b.text).join('');
    const searched = blocks.some(b => b.type === 'server_tool_use');
    const parsed = extractJson(raw);
    if (!parsed || parsed.calories == null) return json(500, { error: 'Could not read nutrition data — try rephrasing' });

    const clean = o => ({
      name: String(o.name || q).slice(0, 120), serving_size: String(o.serving_size || '1 serving').slice(0, 80),
      calories: r0(o.calories) || 0, protein_g: r1(o.protein_g) || 0, carbs_g: r1(o.carbs_g) || 0, fat_g: r1(o.fat_g) || 0,
      sat_fat_g: r1(o.sat_fat_g) || 0, sugar_g: r1(o.sugar_g) || 0, sodium_mg: r0(o.sodium_mg) || 0, fiber_g: r1(o.fiber_g) || 0,
      source: String(o.source || '').slice(0, 80), source_url: /^https?:\/\//.test(o.source_url || '') ? String(o.source_url).slice(0, 500) : '',
    });
    const main = clean(parsed);
    const result = {
      ...main,
      confidence: ['high', 'medium', 'low'].includes(parsed.confidence) ? parsed.confidence : (main.source_url ? 'medium' : 'low'),
      note: String(parsed.note || main.source || '').slice(0, 160),
      alternatives: (Array.isArray(parsed.alternatives) ? parsed.alternatives : []).filter(a => a && a.calories != null && a.name).slice(0, 3).map(clean),
      sources_checked: [...checked, ...(searched ? ['Web search'] : [])],
      web_available: usedWeb,
      model: out.model,
    };
    if (!result.source) result.source = result.source_url ? new URL(result.source_url).hostname.replace(/^www\./, '') : 'Estimate';
    return json(200, result);
  } catch (e) {
    return json(500, { error: e.name === 'AbortError' ? 'Lookup timed out — try again' : e.message });
  }
};
