/* Import: pull the caption / description (and any structured recipe) out of a pasted link.
   Instagram: full caption via the link-preview meta tags (comments need a login, so not available).
   TikTok / YouTube: oEmbed title or the video description. Recipe websites: schema.org Recipe JSON-LD.
   Douyin blocks server requests, but its share text already contains the caption, so we use that. */
const BOT_UA = "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)";
const WEB_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const MAX_HTML = 2_500_000;

const decode = s => String(s || "")
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const meta = (html, prop) => {
  const a = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']*)["']`, "i"))
    || html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${prop}["']`, "i"));
  return a ? decode(a[1]) : "";
};

async function getText(url, ua) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 12000);
  try {
    const r = await fetch(url, { headers: { "User-Agent": ua, "Accept-Language": "en-GB,en;q=0.9" }, redirect: "follow", signal: ctl.signal });
    if (!r.ok) throw new Error(`The page answered ${r.status}`);
    const reader = r.body.getReader(); let got = 0; const chunks = [];
    for (;;) { const { done, value } = await reader.read(); if (done) break; got += value.length; chunks.push(value); if (got > MAX_HTML) { reader.cancel(); break; } }
    const buf = new Uint8Array(got); let o = 0; for (const c of chunks) { buf.set(c, o); o += c.length; }
    return { text: new TextDecoder().decode(buf), url: r.url };
  } finally { clearTimeout(t); }
}

function jsonLdRecipe(html) {
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let data; try { data = JSON.parse(m[1].trim()); } catch (e) { continue; }
    const stack = [data];
    while (stack.length) {
      const x = stack.pop(); if (!x || typeof x !== "object") continue;
      if (Array.isArray(x)) { stack.push(...x); continue; }
      const t = [].concat(x["@type"] || []);
      if (t.includes("Recipe")) {
        const steps = [];
        const walk = s => { if (!s) return; if (typeof s === "string") steps.push(decode(s).replace(/<[^>]+>/g, "").trim());
          else if (Array.isArray(s)) s.forEach(walk); else if (s.itemListElement) walk(s.itemListElement); else if (s.text) steps.push(decode(s.text).replace(/<[^>]+>/g, "").trim()); };
        walk(x.recipeInstructions);
        const mins = iso => { const q = String(iso || "").match(/PT(?:(\d+)H)?(?:(\d+)M)?/); return q ? (+q[1] || 0) * 60 + (+q[2] || 0) : null; };
        return { name: decode(x.name || ""), ingredients: [].concat(x.recipeIngredient || []).map(s => decode(s).trim()).filter(Boolean),
          steps: steps.filter(Boolean), yield: [].concat(x.recipeYield || [])[0] || null, total_minutes: mins(x.totalTime), author: decode([].concat(x.author || [])[0]?.name || "") };
      }
      if (x["@graph"]) stack.push(x["@graph"]);
    }
  }
  return null;
}

export async function importPost(raw) {
  const pasted = String(raw || "").slice(0, 6000);
  const link = (pasted.match(/https?:\/\/[^\s"'<>，。]+/) || [])[0];
  if (!link) return { ok: false, error: "Paste a link (Instagram, TikTok, YouTube, Douyin or a recipe website)." };
  let u; try { u = new URL(link); } catch (e) { return { ok: false, error: "That link doesn't look right." }; }
  if (!/^https?:$/.test(u.protocol)) return { ok: false, error: "Only web links work here." };
  const host = u.hostname.replace(/^www\.|^m\./, "");

  if (/(^|\.)instagram\.com$|^instagr\.am$/.test(host)) {
    const code = (u.pathname.match(/\/(?:p|reel|reels|tv)\/([\w-]+)/) || [])[1];
    if (!code) return { ok: false, error: "That Instagram link isn't a post or reel." };
    const { text } = await getText(`https://www.instagram.com/p/${code}/`, BOT_UA);
    const d = meta(text, "og:description");
    if (!d) return { ok: false, error: "Instagram didn't share this post (it may be private). Paste the caption instead." };
    const m = d.match(/^.*? - ([\w.]+) on [^:]+:\s*"([\s\S]*)"\.?\s*$/);
    return { ok: true, platform: "instagram", url: `https://www.instagram.com/reel/${code}/`, author: m ? m[1] : "", caption: m ? m[2] : d,
      title: "", thumbnail: meta(text, "og:image"), note: "Instagram comments need a login, so they can't be read. If the recipe is in the comments, paste it in too." };
  }
  if (/(^|\.)tiktok\.com$/.test(host)) {
    const r = await fetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent(link)}`, { headers: { "User-Agent": WEB_UA } });
    if (!r.ok) return { ok: false, error: "TikTok didn't share this video. Paste the caption instead." };
    const x = await r.json();
    return { ok: true, platform: "tiktok", url: link, author: x.author_name || "", caption: x.title || "", thumbnail: x.thumbnail_url || "", title: "" };
  }
  if (/(^|\.)douyin\.com$|iesdouyin\.com$/.test(host)) {
    // Douyin's "copy link" text carries the caption: "5.12 复制打开抖音，看看【作者的作品】番茄牛腩... https://v.douyin.com/xxx/ ..."
    let cap = pasted.slice(0, pasted.indexOf(link)).replace(/^[\s\S]*?复制打开抖音[，,]?\s*/, "").replace(/看看【([^】]*)】/, "").replace(/[a-zA-Z0-9@:/.]{6,}\s*$/, "")
      .replace(/\d+\.\d+\s+\S+\/\S+\s*/g, "").replace(/\s{2,}/g, " ").trim();
    const who = (pasted.match(/看看【(.+?)的作品】/) || [])[1] || "";
    return { ok: true, platform: "douyin", url: link, author: who, caption: cap, title: "",
      note: cap.length < 15 ? "Douyin doesn't let the app open videos. Paste the video's description (or the full share text) to import it." : "Douyin only gives the share text, so long captions may be cut short." };
  }
  if (/(^|\.)youtube\.com$|^youtu\.be$/.test(host)) {
    let text = "";
    try { ({ text } = await getText(link, WEB_UA)); } catch (e) {
      // YouTube often refuses cloud servers; the oEmbed endpoint still gives the title
      const r = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(link)}`);
      if (!r.ok) throw e;
      const x = await r.json();
      return { ok: true, platform: "youtube", url: link, author: x.author_name || "", title: x.title || "", caption: "", thumbnail: x.thumbnail_url || "",
        note: "YouTube only shared the title, not the description. If the recipe is in the description, paste it in." };
    }
    const desc = (text.match(/"shortDescription":"((?:[^"\\]|\\.)*)"/) || [])[1];
    return { ok: true, platform: "youtube", url: link, author: meta(text, "og:site_name") === "YouTube" ? (text.match(/"ownerChannelName":"([^"]*)"/) || [])[1] || "" : "",
      title: meta(text, "og:title"), caption: desc ? JSON.parse(`"${desc}"`) : meta(text, "og:description"), thumbnail: meta(text, "og:image") };
  }
  // anything else: a recipe website, ideally with a schema.org Recipe
  const { text, url } = await getText(link, WEB_UA);
  const recipe = jsonLdRecipe(text);
  return { ok: true, platform: "web", url, author: recipe?.author || meta(text, "og:site_name"), title: recipe?.name || meta(text, "og:title") || decode((text.match(/<title>([^<]*)/i) || [])[1] || ""),
    caption: recipe ? "" : meta(text, "og:description") || meta(text, "description"), thumbnail: meta(text, "og:image"), recipe };
}
