"""Build the public web app (docs/) from the cookbook page (src/app.html).

src/app.html is the same page that runs as the private Claude artifact. This script turns it into
a standalone site for GitHub Pages:
  - kitchen codes + live sync through the Cloudflare Worker instead of the artifact's db
  - no creator photos (their video frames stay out of a public site; recipes keep credit + links)
  - AI buttons point people to the Claude connector instead of the artifact's built-in Claude
  - installable on phones (manifest + service worker)

Usage: python build.py https://food-with-asu.<subdomain>.workers.dev
"""
import json, pathlib, sys

ROOT = pathlib.Path(__file__).parent
api = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8787").rstrip("/")
s = (ROOT / "src/app.html").read_text(encoding="utf8")

def rep(a, b, count=1):
    global s
    n = s.count(a)
    assert n == count, f"expected {count}x, found {n}: {a[:70]!r}"
    s = s.replace(a, b)

# creator photos stay private
rep('<script src="img/list.js"></script>\n', "")

# wording that assumed exactly two people sharing an artifact
rep('setSync("Synced for both of you")', 'setSync("Synced")', 2)
rep("Delete removes it for both of you.", "Delete removes it for everyone in your kitchen.")

# recipes Claude saved, either from the fridge box (artifact) or a chat through the connector
rep('ai:"FRIDGE"', 'ai:"CLAUDE"')
rep('["ai","Saved from fridge"]', '["ai","Saved by Claude"]')
rep('r.plat==="ai"?"from the fridge"', 'r.plat==="ai"?(r.via==="chat"?"saved from a Claude chat":"from the fridge")')
rep("Suggested by Claude from what was in the fridge", '${r.via==="chat"?"Written by Claude in a chat":"Suggested by Claude from what was in the fridge"}')

# the AI boxes: no built-in Claude on a normal website, so point at the connector
rep("Open this page in Claude to have Claude invent recipes from what you've picked.",
    "Connect Claude to your kitchen (tap <b>Kitchen</b> at the top), then ask in any Claude chat, e.g. “what can we make with prawns and cream?”. It can save recipes straight into here.")
rep("Not in the cookbook? Open this page inside Claude to ask Claude for a recipe for “${esc(q)}”.",
    "Not in the cookbook? Connect Claude (tap <b>Kitchen</b> at the top) and ask it for “${esc(q)}”. It can save the recipe straight into here.")

# Kitchen button in the header
rep('<div><span class="forlabel">Cooking for</span>',
    '<div class="hdrr"><button class="btn small kbtn" id="kbtn">Share</button><span class="forlabel">Cooking for</span>')

css = """
.hdrr{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.kbtn{margin-right:10px;display:inline-flex;align-items:center;gap:6px}
.kdot{width:8px;height:8px;border-radius:50%;background:var(--accent);display:inline-block}
.kcode{display:flex;align-items:center;gap:10px;flex-wrap:wrap;background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:12px 14px;margin:12px 0}
.kcode .mono{font-size:22px;font-weight:600;letter-spacing:.06em;color:var(--accent);word-break:break-all}
.kcode.url .mono{font-size:13px;letter-spacing:0;color:var(--ink)}
.ksteps{padding-left:20px;display:grid;gap:10px;font-size:14.5px;line-height:1.5}
.kjoin{display:flex;gap:8px;margin:8px 0}
.kjoin input{flex:1;min-width:0;border:1px solid var(--line);border-radius:12px;background:var(--surface);color:var(--ink);padding:9px 12px;font:inherit;font-family:var(--f-mono,monospace);text-transform:uppercase;letter-spacing:.05em}
.sheet.kitchen .err{color:var(--chilli);margin-top:12px}
"""
rep("</style>", css + "</style>")

kitchen = (ROOT / "web/kitchen.js").read_text(encoding="utf8").replace("__API_BASE__", api)
i = s.rindex("<script>")
s = s[:i] + "<script>\n" + kitchen + "\n</script>\n" + s[i:]

head = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="description" content="A shared cookbook and meal planner: weekly plans, a pantry-aware shopping list, and a cook mode with timers. Link up with a kitchen code, and connect Claude.">
<meta name="theme-color" content="#5B4BD6">
<link rel="manifest" href="manifest.webmanifest">
<link rel="icon" href="icon-192.png">
<link rel="apple-touch-icon" href="icon-192.png">
<meta name="apple-mobile-web-app-capable" content="yes">
</head>
<body>
"""
out = ROOT / "docs"
out.mkdir(exist_ok=True)
(out / "index.html").write_text(head + s + "\n</body>\n</html>\n", encoding="utf8")

(out / "manifest.webmanifest").write_text(json.dumps({
    "name": "Food with Asu", "short_name": "Food w/ Asu", "start_url": "./", "scope": "./",
    "display": "standalone", "background_color": "#F4F3FA", "theme_color": "#5B4BD6",
    "icons": [{"src": "icon-192.png", "sizes": "192x192", "type": "image/png"},
              {"src": "icon-512.png", "sizes": "512x512", "type": "image/png"},
              {"src": "icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable"}]}, indent=1), encoding="utf8")

(out / "sw.js").write_text("""// Network first, falling back to the last copy, so the cookbook opens offline in the kitchen.
const CACHE = "fwa-v1";
self.addEventListener("install", e => { self.skipWaiting(); e.waitUntil(caches.open(CACHE).then(c => c.addAll(["./", "manifest.webmanifest", "icon-192.png"]))); });
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", e => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || (u.origin !== location.origin && !u.hostname.endsWith("googleapis.com") && !u.hostname.endsWith("gstatic.com"))) return;
  e.respondWith(fetch(e.request).then(r => { const c = r.clone(); caches.open(CACHE).then(x => x.put(e.request, c)); return r; })
    .catch(() => caches.match(e.request).then(r => r || caches.match("./"))));
});
""", encoding="utf8")
(out / ".nojekyll").write_text("")
print("built docs/ against", api)
