import { DurableObject } from "cloudflare:workers";
import RECIPES from "./recipes.json";
import { handleMcp } from "./mcp.js";
import { freshState } from "./shared.js";
import { importPost } from "./importer.js";

/* Kitchen codes look like K7QM-4XPA-9RTE: 12 characters from a 32-letter alphabet (60 bits),
   with no 0/O/1/I so they're easy to read out. The code is the only key to a kitchen. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function newCode() {
  const b = crypto.getRandomValues(new Uint8Array(12));
  const s = [...b].map(x => ALPHABET[x & 31]).join("");
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
}
export function normCode(raw) {
  const s = String(raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (s.length !== 12 || [...s].some(c => !ALPHABET.includes(c))) return null;
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
}

const MAX_STATE = 600_000;   // bytes of planner/pantry state
const MAX_RECIPE = 250_000;  // one saved recipe, photo included
const MAX_RECIPES = 300;

export class Kitchen extends DurableObject {
  async exists() { return !!(await this.ctx.storage.get("meta")); }
  async create(seed) {
    if (await this.exists()) return false;
    await this.ctx.storage.put("meta", { created: Date.now() });
    if (seed && seed.state && JSON.stringify(seed.state).length <= MAX_STATE) await this.ctx.storage.put("state", seed.state);
    for (const r of (seed && Array.isArray(seed.custom) ? seed.custom : []).slice(0, MAX_RECIPES))
      if (r && typeof r.id === "string" && JSON.stringify(r).length <= MAX_RECIPE) await this.ctx.storage.put("c:" + r.id, r);
    return true;
  }
  async getState() { return (await this.ctx.storage.get("state")) || null; }
  async setState(state, except) {
    if (!state || typeof state !== "object" || JSON.stringify(state).length > MAX_STATE) throw new Error("Plan too large");
    await this.ctx.storage.put("state", state);
    this.broadcast({ t: "state", data: state }, except);
  }
  async listCustom() { return [...(await this.ctx.storage.list({ prefix: "c:" })).values()]; }
  async putCustom(r, except) {
    if (!r || typeof r.id !== "string" || !/^[\w-]{1,60}$/.test(r.id)) throw new Error("Bad recipe id");
    if (JSON.stringify(r).length > MAX_RECIPE) throw new Error("Recipe too large (is the photo huge?)");
    const n = (await this.ctx.storage.list({ prefix: "c:", limit: MAX_RECIPES + 1 })).size;
    if (n >= MAX_RECIPES && !(await this.ctx.storage.get("c:" + r.id))) throw new Error("Too many saved recipes");
    await this.ctx.storage.put("c:" + r.id, r);
    this.broadcast({ t: "custom", list: await this.listCustom() }, except);
  }
  async deleteCustom(id, except) {
    const had = await this.ctx.storage.delete("c:" + id);
    this.broadcast({ t: "custom", list: await this.listCustom() }, except);
    return had;
  }

  broadcast(msg, except) {
    const s = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) if (ws !== except) { try { ws.send(s); } catch (e) {} }
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected a websocket", { status: 426 });
    if (!(await this.exists())) return new Response("No such kitchen", { status: 404 });
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify({ t: "state", data: await this.getState() }));
    server.send(JSON.stringify({ t: "custom", list: await this.listCustom() }));
    return new Response(null, { status: 101, webSocket: client });
  }
  async webSocketMessage(ws, raw) {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    try {
      if (m.t === "set") await this.setState(m.data, ws);
      else if (m.t === "putCustom") await this.putCustom(m.r, ws);
      else if (m.t === "delCustom") await this.deleteCustom(String(m.id), ws);
      else if (m.t === "ping") ws.send('{"t":"pong"}');
      if (m.n) ws.send(JSON.stringify({ t: "ack", n: m.n }));
    } catch (e) { ws.send(JSON.stringify({ t: "error", n: m.n, message: e.message })); }
  }
  async webSocketClose(ws, code) { try { ws.close(code, "bye"); } catch (e) {} }
}

const kitchen = (env, code) => env.KITCHEN.get(env.KITCHEN.idFromName(code));

function cors(req, env) {
  const o = req.headers.get("Origin");
  const ok = o && String(env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).includes(o);
  return ok ? { "Access-Control-Allow-Origin": o, "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type", Vary: "Origin" } : {};
}
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...headers } });

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname.split("/").filter(Boolean);
    const h = cors(req, env);
    // the link importer is open to any page (it returns only text pulled from public posts)
    if (url.pathname === "/api/import" && req.method === "OPTIONS")
      return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "86400" } });
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });

    // Claude connector: https://<worker>/mcp/<KITCHEN-CODE>
    if (p[0] === "mcp") {
      const code = normCode(p[1]);
      if (!code) return json({ error: "Add your kitchen code to the end of the connector URL." }, 404);
      return handleMcp(req, { code, k: kitchen(env, code), RECIPES });
    }

    if (p[0] === "api") {
      // read a recipe post's caption; open to any page (no credentials, returns only extracted text)
      if (p[1] === "import") {
        const open = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };
        if (req.method !== "POST") return json({ error: "POST {text}" }, 405, open);
        let text = ""; try { text = String((await req.json()).text || ""); } catch (e) {}
        try { return json(await importPost(text), 200, open); }
        catch (e) { return json({ ok: false, error: "Couldn't open that link (" + (e.message || "error") + "). Paste the caption instead." }, 200, open); }
      }
      if (req.method === "POST" && p[1] === "kitchens" && p.length === 2) {
        let seed = null;
        try { const t = await req.text(); if (t.length > 3_000_000) return json({ error: "Too much data" }, 413, h); seed = t ? JSON.parse(t) : null; } catch (e) {}
        for (let i = 0; i < 3; i++) {
          const code = newCode();
          if (await kitchen(env, code).create(seed)) return json({ code }, 201, h);
        }
        return json({ error: "Try again" }, 500, h);
      }
      if (p[1] === "k" && p[2]) {
        const code = normCode(p[2]);
        if (!code) return json({ error: "That doesn't look like a kitchen code" }, 400, h);
        if (p[3] === "ws") return kitchen(env, code).fetch(req);
        if (req.method === "GET" && p.length === 3) return json({ code, exists: await kitchen(env, code).exists() }, 200, h);
      }
      return json({ error: "Not found" }, 404, h);
    }

    if (url.pathname === "/") return new Response("Food with Asu sync + Claude connector. Nothing to see here.", { headers: { "Content-Type": "text/plain" } });
    return new Response("Not found", { status: 404 });
  },
};
