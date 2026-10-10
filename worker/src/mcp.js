/* The Claude connector: a small MCP server over Streamable HTTP (stateless, JSON responses).
   Each kitchen has its own URL, https://<worker>/mcp/<KITCHEN-CODE>, which people add as a
   custom connector in Claude. Tools read and write the same kitchen the web app syncs with. */
import { freshState, emptyWeek } from "./shared.js";
import { importPost } from "./importer.js";
import { nutOf } from "./nutrition.js";

const VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const DAY_NAMES = { mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" };
const AISLES = ["veg", "meat", "fish", "dairy", "bakery", "cupboard", "world", "spice", "drink", "frozen", "staple"];
const UNITS = ["g", "ml", "tsp", "tbsp", "", "clove", "bunch", "sprig", "cm"];
const CATS = ["main", "side", "snack", "dessert"];
const PROS = ["chicken", "beef", "pork", "fish", "veg", "sweet"];
const TAGS = ["quick", "weeknight", "meal prep", "air fryer", "chinese", "noodles", "one pan", "curry", "spicy", "japanese", "pasta", "slow cook", "weekend project", "date night", "party", "fried", "rice bowl", "korean"];

const INSTRUCTIONS = `This is the user's shared kitchen in the "Food with Asu" cookbook web app (UK; they shop at Sainsbury's/Waitrose and own an oven and an air fryer). Changes you make appear live in the app for everyone in the kitchen.
- Start with kitchen_overview to see the week, pantry and how many people they cook for.
- To find dishes, use search_recipes before inventing new ones; recipe ids come from there.
- When you write a new recipe (on request, or from what's in the fridge), use UK supermarket ingredients, metric amounts, and put any time in the step text (e.g. "simmer 10 min") with timer_minutes so the app makes a timer. Save it with save_recipe only if the user wants it kept.
- Prefer ingredients in their pantry; if suggesting from what they have, need at most 1-2 things to buy.
- Planner: set_meals fills lunch/dinner slots. Don't overwrite locked slots unless asked.
- Nutrition: search_recipes can filter by protein, fibre, calories and salt per portion; get_week_plan shows each day's per-person totals for lunch + dinner against targets. Use these when asked to plan healthily.`;

const TOOLS = [
  { name: "kitchen_overview", title: "Kitchen overview", description: "Summary of the kitchen: how many people, today's day, this week's planned meals, pantry status, and recipe counts. Call this first.",
    inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
  { name: "search_recipes", title: "Search recipes", description: "Search the cookbook (built-in plus saved recipes). Filter by words, max total minutes, protein, category, or ingredients it must use. Returns ids, names, times and key ingredients.",
    inputSchema: { type: "object", properties: {
      query: { type: "string", description: "Words to match in name, tags, creator or ingredients, e.g. 'prawn pasta' or '牛肉'" },
      max_minutes: { type: "integer", minimum: 1 },
      protein: { type: "string", enum: PROS },
      category: { type: "string", enum: CATS },
      uses_ingredients: { type: "array", items: { type: "string" }, description: "Every one must appear in the recipe, e.g. ['prawns','cream']" },
      min_protein_g: { type: "number", description: "Per portion, e.g. 30 for high protein" },
      min_fibre_g: { type: "number", description: "Per portion, e.g. 8 for high fibre" },
      max_kcal: { type: "number", description: "Per portion" }, max_salt_g: { type: "number", description: "Per portion" },
      limit: { type: "integer", minimum: 1, maximum: 50, default: 15 } } }, annotations: { readOnlyHint: true } },
  { name: "get_recipe", title: "Get a recipe", description: "Full recipe by id: ingredients (scaled to the given portions), steps with timers, tips, air-fryer method, meal-prep notes.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, portions: { type: "integer", minimum: 1, maximum: 12 } }, required: ["id"] }, annotations: { readOnlyHint: true } },
  { name: "save_recipe", title: "Save a recipe", description: "Save a recipe you wrote into the kitchen's cookbook so it shows up in the app. Pass an existing saved recipe id to update it.",
    inputSchema: { type: "object", properties: {
      id: { type: "string", description: "Only to update a recipe previously saved with this tool" },
      name: { type: "string" }, chinese_name: { type: "string" },
      category: { type: "string", enum: CATS }, protein: { type: "string", enum: PROS },
      serves: { type: "integer", minimum: 1, maximum: 12 }, total_minutes: { type: "integer", minimum: 1, maximum: 600 }, hands_on_minutes: { type: "integer", minimum: 1, maximum: 300 },
      tags: { type: "array", items: { type: "string", enum: TAGS } },
      ingredients: { type: "array", description: "In order of use. Use {heading:'For the sauce'} for a sub-heading.", items: { type: "object", properties: {
        qty: { type: ["number", "null"], description: "Amount for `serves` people; null for 'to taste'" },
        unit: { type: "string", enum: [...UNITS, "kg", "l"], description: "'' for counts (2 eggs)" },
        name: { type: "string", description: "Lower case, UK name, e.g. 'double cream', 'spring onions'" },
        aisle: { type: "string", enum: AISLES }, note: { type: "string", description: "e.g. 'finely chopped'" },
        heading: { type: "string" } } } },
      steps: { type: "array", items: { type: "object", properties: {
        text: { type: "string" }, timer_minutes: { type: "number", description: "If the step has a wait, e.g. 10" }, timer_label: { type: "string", description: "Short, e.g. 'Simmer'" } }, required: ["text"] } },
      tip: { type: "string" }, blurb: { type: "string", description: "One line about the dish" },
      source_link: { type: "string", description: "Link to the original video/post if it came from one" }, creator: { type: "string", description: "Creator's handle if imported, e.g. @rafifronz" } },
      required: ["name", "category", "protein", "serves", "total_minutes", "ingredients", "steps"] } },
  { name: "delete_saved_recipe", title: "Delete a saved recipe", description: "Delete a recipe that was saved into this kitchen (ids starting ai- or me-). Built-in recipes can't be deleted this way.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] }, annotations: { destructiveHint: true } },
  { name: "get_week_plan", title: "Get this week's plan", description: "Every lunch and dinner slot this week with recipe ids, portions and whether it's locked.",
    inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
  { name: "set_meals", title: "Plan meals", description: "Set or clear lunch/dinner slots. Each item: day (mon..sun), meal (lunch|dinner), and either recipe_id or special (ramen | leftovers | eating_out | clear). Portions default to the kitchen's people count.",
    inputSchema: { type: "object", properties: { meals: { type: "array", items: { type: "object", properties: {
      day: { type: "string", enum: DAYS }, meal: { type: "string", enum: ["lunch", "dinner"] }, recipe_id: { type: "string" },
      special: { type: "string", enum: ["ramen", "leftovers", "eating_out", "clear"] }, portions: { type: "integer", minimum: 1, maximum: 12 }, lock: { type: "boolean" } },
      required: ["day", "meal"] } } }, required: ["meals"] } },
  { name: "get_shopping_list", title: "Shopping list", description: "Ingredients needed for this week's planned meals, added up and grouped by supermarket aisle, with pantry items marked.",
    inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
  { name: "get_pantry", title: "Get pantry", description: "Long-lasting items (oils, sauces, spices, dry goods) marked as 'have' or 'low'.",
    inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
  { name: "read_recipe_link", title: "Read a recipe link", description: "Fetch the caption / description from an Instagram, TikTok, YouTube or Douyin link (or a recipe website's structured recipe) so you can turn it into a recipe. Instagram comments and spoken audio can't be read. After reading, write the recipe faithfully from the creator's own amounts (estimate only what's missing and say so), credit the creator, and save it with save_recipe (put the link in source_link) if the user wants it kept.",
    inputSchema: { type: "object", properties: { link: { type: "string", description: "The URL, or the whole share text (Douyin share text includes the caption)" } }, required: ["link"] }, annotations: { readOnlyHint: true, openWorldHint: true } },
  { name: "update_pantry", title: "Update pantry", description: "Mark pantry items as have, low (needs restocking, goes on the shopping list) or remove.",
    inputSchema: { type: "object", properties: { items: { type: "array", items: { type: "object", properties: {
      name: { type: "string" }, status: { type: "string", enum: ["have", "low", "remove"] } }, required: ["name", "status"] } } }, required: ["items"] } },
];

/* ---------- helpers ---------- */
const all = async (ctx) => {
  const custom = await ctx.k.listCustom();
  const st = (await ctx.k.getState()) || freshState();
  const gone = new Set([...(st.hidden || []), ...(st.deleted || [])]);
  const byId = {};
  for (const r of ctx.RECIPES) byId[r.id] = r;
  for (const r of custom) byId[r.id] = { ...r, plat: r.mine ? "own" : "ai" };
  return { st, byId, list: Object.values(byId).filter(r => !gone.has(r.id)), custom };
};
const srcOf = r => r.plat === "ai" ? "saved by Claude" : r.plat === "own" ? "their own recipe" : r.plat === "extra" ? "app idea" : r.plat === "dy" ? `Douyin (${r.by})` : `Instagram @${r.by}`;
const keyIngs = r => r.ing.filter(i => i[0] !== "—" && !["staple", "spice"].includes(i[3])).map(i => i[2]).slice(0, 10);
const frac = q => Math.round(q * 100) / 100;
function scaled(r, p) {
  const f = r.fixed ? 1 : (p || r.serves) / r.serves;
  return r.ing.map(i => i[0] === "—" ? `— ${i[2]} —` : `${typeof i[0] === "number" ? frac(i[0] * f) + (i[1] ? " " + i[1] : "") + " " : i[0] == null ? "" : ""}${i[2]}${i[0] == null ? " (to taste)" : ""}${i[4] ? ` (${i[4]})` : ""}`);
}
function slotText(s, byId) {
  if (!s) return null;
  if (s.ramen) return { special: "ramen night", portions: s.p, lock: !!s.lock };
  if (s.left) return { special: "leftovers", lock: !!s.lock };
  if (s.out) return { special: "eating out", lock: !!s.lock };
  const r = byId[s.r];
  return r ? { recipe_id: r.id, name: r.n, portions: s.p, minutes: r.time, lock: !!s.lock, from_meal_prep: !!s.fromPrep } : null;
}
function weekOf(st, byId) {
  const w = st.week || emptyWeek();
  return Object.fromEntries(DAYS.map(d => [DAY_NAMES[d], { lunch: slotText(w[d]?.l, byId), dinner: slotText(w[d]?.d, byId) }]));
}
const today = () => new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(new Date());

function cleanRecipe(a, id) {
  const str = (v, n) => String(v ?? "").trim().slice(0, n);
  const num = (v, d, lo, hi) => { v = Number(v); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d; };
  const ing = [];
  for (const x of (Array.isArray(a.ingredients) ? a.ingredients : []).slice(0, 45)) {
    if (!x || typeof x !== "object") continue;
    if (x.heading && !x.name) { ing.push(["—", "", str(x.heading, 40)]); continue; }
    const name = str(x.name, 50).toLowerCase(); if (!name) continue;
    let q = x.qty == null || x.qty === "" ? null : Number(x.qty); if (q != null && !Number.isFinite(q)) q = null;
    let u = str(x.unit, 6).toLowerCase();
    if (u === "kg") { u = "g"; q = q == null ? q : q * 1000; } else if (u === "l") { u = "ml"; q = q == null ? q : q * 1000; }
    if (!UNITS.includes(u)) u = "";
    const row = [q, u, name, AISLES.includes(x.aisle) ? x.aisle : "cupboard"];
    if (x.note) row.push(str(x.note, 60));
    ing.push(row);
  }
  const steps = (Array.isArray(a.steps) ? a.steps : []).slice(0, 20).map(s => {
    const t = str(typeof s === "string" ? s : s && s.text, 500); if (!t) return null;
    const m = Number(s && s.timer_minutes);
    return Number.isFinite(m) && m > 0 ? [t, Math.min(300, Math.max(1, Math.round(m))), str(s.timer_label || "Timer", 24)] : [t];
  }).filter(Boolean);
  if (!ing.some(i => i[0] !== "—")) throw new Error("A recipe needs at least one ingredient.");
  if (!steps.length) throw new Error("A recipe needs at least one step.");
  const time = num(a.total_minutes, 30, 1, 600);
  return { id, n: str(a.name, 80) || "New recipe", zh: str(a.chinese_name, 30), blurb: str(a.blurb, 160),
    cat: CATS.includes(a.category) ? a.category : "main", pro: PROS.includes(a.protein) ? a.protein : "veg",
    serves: num(a.serves, 2, 1, 12), time, active: num(a.hands_on_minutes, Math.min(time, 25), 1, 300),
    tags: (Array.isArray(a.tags) ? a.tags : []).filter(t => TAGS.includes(t)).slice(0, 6), prep: (a.tags || []).includes("meal prep"),
    note: str(a.tip, 400), ing, steps, src: "ai", plat: "ai", by: "Claude", via: "chat",
    link: /^https?:\/\//.test(String(a.source_link || "")) ? str(a.source_link, 300) : undefined, creator: str(a.creator, 40).replace(/^@?/, a.creator ? "@" : "") || undefined,
    savedOn: new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", day: "numeric", month: "short" }).format(new Date()) };
}

const nutBrief = r => { const v = nutOf(r).per; return { kcal: Math.round(v.kcal), protein_g: Math.round(v.protein), carbs_g: Math.round(v.carbs), fat_g: Math.round(v.fat), fibre_g: +v.fibre.toFixed(1), sugars_g: Math.round(v.sugars), salt_g: +v.salt.toFixed(1) }; };
/* ---------- tools ---------- */
const run = {
  async kitchen_overview(_, ctx) {
    const { st, byId, list, custom } = await all(ctx);
    const pantry = Object.entries(st.pantry || {});
    return { today: today(), cooking_for: st.people || 2, plan_weekday_lunches: st.wlunch !== false, meal_prep_on: !!st.mpOn,
      this_week: weekOf(st, byId), pantry_have: pantry.filter(([, v]) => v === 1).map(([n]) => n), pantry_low: pantry.filter(([, v]) => v === 2).map(([n]) => n),
      recipes: { total: list.length, saved_in_this_kitchen: custom.length }, appliances: ["oven", "air fryer", "hob"] };
  },
  async search_recipes(a, ctx) {
    const { list } = await all(ctx);
    const words = String(a.query || "").toLowerCase().split(/\s+/).filter(Boolean);
    const must = (a.uses_ingredients || []).map(s => String(s).toLowerCase()).filter(Boolean);
    const N = r => nutOf(r).per;
    const hits = list.filter(r => {
      if (a.min_protein_g && N(r).protein < a.min_protein_g) return false;
      if (a.min_fibre_g && N(r).fibre < a.min_fibre_g) return false;
      if (a.max_kcal && N(r).kcal > a.max_kcal) return false;
      if (a.max_salt_g && N(r).salt > a.max_salt_g) return false;
      if (a.max_minutes && r.time > a.max_minutes) return false;
      if (a.protein && r.pro !== a.protein) return false;
      if (a.category && r.cat !== a.category) return false;
      const ings = r.ing.map(i => String(i[2]).toLowerCase());
      if (must.some(m => !ings.some(n => n.includes(m) || m.includes(n)))) return false;
      if (!words.length) return true;
      const hay = [r.n, r.zh, r.by, ...(r.tags || []), ...ings].join(" ").toLowerCase();
      return words.every(w => hay.includes(w));
    }).slice(0, Math.min(50, a.limit || 15));
    return { count: hits.length, recipes: hits.map(r => ({ id: r.id, name: r.n, chinese_name: r.zh || undefined, minutes: r.time, protein: r.pro, category: r.cat, serves: r.serves, tags: r.tags, source: srcOf(r), key_ingredients: keyIngs(r), per_portion: nutBrief(r) })) };
  },
  async get_recipe(a, ctx) {
    const { byId, st } = await all(ctx);
    const r = byId[a.id]; if (!r) throw new Error(`No recipe with id ${a.id}. Use search_recipes to find ids.`);
    const p = a.portions || st.people || 2;
    return { id: r.id, name: r.n, chinese_name: r.zh || undefined, source: srcOf(r), category: r.cat, protein: r.pro, total_minutes: r.time, hands_on_minutes: r.active,
      original_serves: r.serves, portions: r.fixed ? r.fixed : p, ingredients: scaled(r, p), nutrition_per_portion: { ...nutBrief(r), note: "Estimate from the ingredients (typical UK values)" },
      steps: r.steps.map((s, i) => `${i + 1}. ${s[0]}${s[1] ? ` [timer: ${s[2]} ${s[1]} min]` : ""}`), tip: r.note || undefined, air_fryer: r.af || undefined, meal_prep: r.mp || undefined, tags: r.tags };
  },
  async save_recipe(a, ctx) {
    let id = a.id && /^ai-[\w-]+$/.test(a.id) ? a.id : null;
    if (a.id && !id) throw new Error("Only recipes saved with this tool (ids starting ai-) can be updated.");
    id = id || "ai-" + Date.now().toString(36) + "-c";
    const r = cleanRecipe(a, id);
    await ctx.k.putCustom(r);
    return { saved: true, id, name: r.n, note: "It's now in the app's cookbook under 'Saved by Claude'." };
  },
  async delete_saved_recipe(a, ctx) {
    if (!/^(ai|me)-[\w-]+$/.test(String(a.id))) throw new Error("Only recipes saved into this kitchen can be deleted. Built-in ones can be archived in the app.");
    const had = await ctx.k.deleteCustom(a.id);
    return { deleted: had, id: a.id };
  },
  async get_week_plan(_, ctx) {
    const { st, byId } = await all(ctx);
    const w = st.week || emptyWeek(), daily = {};
    for (const d of DAYS) { const t = { kcal: 0, protein_g: 0, fibre_g: 0, salt_g: 0, meals_counted: 0 };
      for (const k of ["l", "d"]) { const s = w[d] && w[d][k]; const r = s && s.r && byId[s.r]; if (!r) continue; const v = nutOf(r).per;
        t.kcal += v.kcal; t.protein_g += v.protein; t.fibre_g += v.fibre; t.salt_g += v.salt; t.meals_counted++; }
      daily[DAY_NAMES[d]] = { kcal: Math.round(t.kcal), protein_g: Math.round(t.protein_g), fibre_g: +t.fibre_g.toFixed(1), salt_g: +t.salt_g.toFixed(1), meals_counted: t.meals_counted }; }
    return { cooking_for: st.people || 2, healthy_goal: st.goal || "none", week: weekOf(st, byId),
      nutrition_per_person_lunch_and_dinner: daily, targets_for_two_meals: "1000-1700 kcal, ≥35 g protein, ≥12 g fibre, ≤4.2 g salt" };
  },
  async set_meals(a, ctx) {
    const { st, byId } = await all(ctx);
    st.week = st.week || emptyWeek();
    const done = [];
    for (const m of (a.meals || []).slice(0, 14)) {
      if (!DAYS.includes(m.day) || !["lunch", "dinner"].includes(m.meal)) throw new Error(`Bad slot ${m.day} ${m.meal}`);
      const k = m.meal === "lunch" ? "l" : "d", p = m.portions || st.people || 2;
      let s;
      if (m.special === "clear") s = null;
      else if (m.special === "ramen") s = { ramen: true, p };
      else if (m.special === "leftovers") s = { left: true };
      else if (m.special === "eating_out") s = { out: true };
      else { if (!byId[m.recipe_id]) throw new Error(`No recipe with id ${m.recipe_id}`); s = { r: m.recipe_id, p }; }
      if (s && m.lock) s.lock = true;
      st.week[m.day] = st.week[m.day] || { l: null, d: null };
      st.week[m.day][k] = s;
      done.push(`${DAY_NAMES[m.day]} ${m.meal}: ${s ? (s.r ? byId[s.r].n : m.special) : "cleared"}`);
    }
    st.saved = true;
    await ctx.k.setState(st);
    return { updated: done };
  },
  async get_shopping_list(_, ctx) {
    const { st, byId } = await all(ctx);
    const tot = new Map(), w = st.week || emptyWeek();
    const add = (r, p, why) => {
      const f = r.fixed ? 1 : p / r.serves;
      for (const i of r.ing) {
        if (i[0] === "—") continue;
        const key = i[2] + "|" + i[1];
        const e = tot.get(key) || { name: i[2], unit: i[1], aisle: i[3], qty: 0, any: false, for: new Set() };
        if (typeof i[0] === "number") e.qty += i[0] * f; else e.any = true;
        e.for.add(why); tot.set(key, e);
      }
    };
    let ramen = 0;
    for (const d of DAYS) for (const k of ["l", "d"]) {
      const s = w[d] && w[d][k]; if (!s) continue;
      if (s.ramen) ramen += s.p || 1;
      else if (s.r && byId[s.r] && !s.fromPrep) add(byId[s.r], s.p || 2, byId[s.r].n);
    }
    for (const b of st.prep || []) if (byId[b.r]) add(byId[b.r], b.p || 2, byId[b.r].n + " (meal prep)");
    const pantry = st.pantry || {};
    const groups = {};
    for (const e of tot.values()) {
      const inPantry = pantry[e.name] === 1;
      (groups[e.aisle] = groups[e.aisle] || []).push(`${e.qty ? frac(e.qty) + (e.unit ? " " + e.unit : "") + " " : ""}${e.name}${inPantry ? " — already in pantry" : ""} (for ${[...e.for].join(", ")})`);
    }
    if (ramen) (groups.world = groups.world || []).push(`${ramen} instant ramen packs (ramen night)`);
    const low = Object.entries(pantry).filter(([, v]) => v === 2).map(([n]) => n);
    return { note: "Approximate: the app's own list also handles pack sizes and ticked items.", by_aisle: groups, restock_from_pantry: low };
  },
  async get_pantry(_, ctx) {
    const { st } = await all(ctx);
    const e = Object.entries(st.pantry || {});
    return { have: e.filter(([, v]) => v === 1).map(([n]) => n), low: e.filter(([, v]) => v === 2).map(([n]) => n) };
  },
  async read_recipe_link(a) { return await importPost(a.link); },
  async update_pantry(a, ctx) {
    const st = (await ctx.k.getState()) || freshState();
    st.pantry = st.pantry || {}; st.pantryExtra = st.pantryExtra || [];
    for (const it of (a.items || []).slice(0, 60)) {
      const n = String(it.name || "").trim().toLowerCase().replace(/\s+/g, " ").slice(0, 40); if (!n) continue;
      if (it.status === "remove") delete st.pantry[n];
      else { st.pantry[n] = it.status === "low" ? 2 : 1; if (!st.pantryExtra.includes(n)) st.pantryExtra.push(n); }
    }
    st.saved = true;
    await ctx.k.setState(st);
    return { ok: true, have: Object.keys(st.pantry).filter(n => st.pantry[n] === 1).length, low: Object.keys(st.pantry).filter(n => st.pantry[n] === 2) };
  },
};

/* ---------- JSON-RPC ---------- */
async function one(msg, ctx) {
  const { id, method, params } = msg || {};
  if (id === undefined || id === null) return null; // notification
  const ok = result => ({ jsonrpc: "2.0", id, result });
  const err = (code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
  switch (method) {
    case "initialize": {
      const v = VERSIONS.includes(params?.protocolVersion) ? params.protocolVersion : VERSIONS[1];
      return ok({ protocolVersion: v, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "food-with-asu", title: "Food with Asu kitchen", version: "1.0.0" }, instructions: INSTRUCTIONS });
    }
    case "ping": return ok({});
    case "tools/list": return ok({ tools: TOOLS });
    case "tools/call": {
      const f = run[params?.name];
      if (!f) return err(-32602, `Unknown tool ${params?.name}`);
      try {
        const out = await f(params.arguments || {}, ctx);
        return ok({ content: [{ type: "text", text: JSON.stringify(out, null, 1) }] });
      } catch (e) {
        return ok({ content: [{ type: "text", text: e.message || String(e) }], isError: true });
      }
    }
    default: return err(-32601, `Method not found: ${method}`);
  }
}

export async function handleMcp(req, ctx) {
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
  if (!(await ctx.k.exists())) return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Kitchen code not found. Check the connector URL in the app's Kitchen panel." } }, { status: 404 });
  let body; try { body = await req.json(); } catch (e) { return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400 }); }
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map(m => one(m, ctx)))).filter(Boolean);
    return out.length ? Response.json(out) : new Response(null, { status: 202 });
  }
  const out = await one(body, ctx);
  return out ? Response.json(out) : new Response(null, { status: 202 });
}
