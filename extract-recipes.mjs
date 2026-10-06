// Pulls the finished recipe list out of src/app.html so the Worker can search it.
import fs from "node:fs";
import vm from "node:vm";
const html = fs.readFileSync(new URL("./src/app.html", import.meta.url), "utf8");
const start = html.lastIndexOf("<script>") + 8;
const end = html.indexOf("const ALSO=[", start);
const code = html.slice(start, end) + ";globalThis.__R=RECIPES;";
const ctx = { window: { IMGS: [] } };
vm.createContext(ctx);
vm.runInContext(code, ctx);
const keep = ["id","n","zh","by","plat","cat","pro","serves","time","active","tags","ing","steps","note","mp","af","prep","fixed","code","vids"];
const out = ctx.__R.map(r => Object.fromEntries(keep.filter(k => r[k] !== undefined).map(k => [k, r[k]])));
fs.writeFileSync(new URL("./worker/src/recipes.json", import.meta.url), JSON.stringify(out));
console.log(out.length, "recipes,", JSON.stringify(out).length, "bytes");
