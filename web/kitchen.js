/* ============ KITCHEN: codes + live sync (web version) ============
   Stands in for the Claude artifact's `db` capability: window.claude.use("db") returns an object
   with the same doc / collection / onSnapshot shape, backed by the Worker over a websocket.
   With no kitchen joined it returns null and the app keeps everything on this device. */
const API_BASE = "__API_BASE__";
const KC_LS = "fwa-kitchen";
let KCODE = null; try { KCODE = localStorage.getItem(KC_LS); } catch (e) {}
const kcSave = c => { try { c ? localStorage.setItem(KC_LS, c) : localStorage.removeItem(KC_LS); } catch (e) {} };
const connectorUrl = () => `${API_BASE}/mcp/${KCODE}`;

function kitchenDb(code) {
  const url = API_BASE.replace(/^http/, "ws") + "/api/k/" + code + "/ws";
  let ws = null, open = false, retry = 0, skipState = false, n = 0;
  let pendingSet = null; const queue = [];
  const stateCbs = [], customCbs = [];
  const snap = d => ({ exists: !!d, data: () => d, metadata: { hasPendingWrites: false } });
  const send = m => { m.n = ++n; const s = JSON.stringify(m); if (open) ws.send(s); else queue.push(s); };
  function connect() {
    ws = new WebSocket(url);
    ws.onopen = () => {
      open = true; retry = 0;
      // edits made while offline win over the copy the server sends on connect
      if (pendingSet) { skipState = true; ws.send(JSON.stringify({ t: "set", n: ++n, data: pendingSet })); pendingSet = null; }
      while (queue.length) ws.send(queue.shift());
    };
    ws.onmessage = e => {
      let m; try { m = JSON.parse(e.data); } catch (x) { return; }
      if (m.t === "state") { if (skipState) { skipState = false; return; } stateCbs.forEach(f => f(snap(m.data))); }
      else if (m.t === "custom") customCbs.forEach(f => f({ docs: (m.list || []).map(x => ({ data: () => x })) }));
      else if (m.t === "error") toast("Couldn't sync: " + m.message);
    };
    ws.onclose = () => {
      open = false;
      if (typeof setSync === "function") setSync("Offline, saved on this device");
      setTimeout(connect, Math.min(30000, 1000 * 2 ** retry++));
    };
  }
  setInterval(() => { if (open) ws.send('{"t":"ping"}'); }, 45000);
  connect();
  return {
    doc(path) {
      if (path === "shared/kitchen") return {
        onSnapshot(cb) { stateCbs.push(cb); },
        set(data) { if (open) send({ t: "set", data }); else pendingSet = data; return Promise.resolve(); },
      };
      const id = path.replace(/^custom\//, "");
      return {
        set(r) { send({ t: "putCustom", r }); return Promise.resolve(); },
        delete() { send({ t: "delCustom", id }); return Promise.resolve(); },
      };
    },
    collection() { return { onSnapshot(cb) { customCbs.push(cb); } }; },
  };
}

window.claude = { use: async name => (name === "db" && KCODE ? kitchenDb(KCODE) : null) };

// a kitchen that no longer exists: drop the link rather than retrying forever
if (KCODE) fetch(`${API_BASE}/api/k/${encodeURIComponent(KCODE)}`).then(r => r.json()).then(x => {
  if (x && x.exists === false) { kcSave(null); toast("That kitchen code no longer works, so this device is on its own again."); setTimeout(() => location.reload(), 1800); }
}).catch(() => {});

/* ---- Kitchen panel ---- */
let KC_ERR = "", KC_BUSY = false;
function renderKitchen() {
  const esc2 = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const body = KCODE ? `
    <div class="eyebrow">Your kitchen</div><h2>Shared kitchen</h2>
    <p class="note">Everyone with this code shares the plan, pantry, shopping list and saved recipes, live. Anyone with the code can change things, so only give it to people you cook with.</p>
    <div class="kcode"><span class="mono">${esc2(KCODE)}</span><button class="btn small" data-kcopy="${esc2(KCODE)}">Copy code</button></div>
    <h4>Connect Claude</h4>
    <p class="note">Let Claude find and write recipes, plan your week and update the pantry for this kitchen, from any Claude chat on your own Claude account.</p>
    <ol class="ksteps">
      <li>In Claude (claude.ai or the app), open <b>Settings → Connectors</b> and choose <b>Add custom connector</b>.</li>
      <li>Name it <b>Food with Asu</b> and paste this URL:<div class="kcode url"><span class="mono">${esc2(connectorUrl())}</span><button class="btn small" data-kcopy="${esc2(connectorUrl())}">Copy URL</button></div></li>
      <li>In a chat, switch the connector on from the tools menu, then ask things like <i>“find me a recipe for 鸡翅包虾滑 and save it”</i>, <i>“what can we make with prawns and cream?”</i> or <i>“plan dinners next week, nothing over 30 min on weekdays”</i>.</li>
    </ol>
    <p class="note">The URL contains your kitchen code, so treat it like the code. Custom connectors may need a paid Claude plan.</p>
    <div class="btnrow" style="margin-top:22px"><button class="ib danger" id="kleave">Leave this kitchen</button><span class="note">This device keeps a copy of everything.</span></div>`
  : `
    <div class="eyebrow">Kitchen</div><h2>Cook together</h2>
    <p class="note">Right now everything is saved on this device only. Start a kitchen to get a code. Anyone who enters it shares your plan, pantry, shopping list and saved recipes, and changes show up for everyone straight away.</p>
    <div class="btnrow" style="margin:14px 0 22px"><button class="btn primary" id="kstart" ${KC_BUSY ? "disabled" : ""}>${KC_BUSY ? "Starting…" : "Start a kitchen"}</button></div>
    <h4>Got a code?</h4>
    <form id="kjoin" class="kjoin" autocomplete="off"><input id="kcodein" type="text" inputmode="text" autocapitalize="characters" placeholder="e.g. K7QM-4XPA-9RTE" maxlength="20" aria-label="Kitchen code"><button class="btn" type="submit" ${KC_BUSY ? "disabled" : ""}>Join</button></form>
    <p class="note">Joining shows that kitchen's plan on this device instead of what's here now.</p>
    <h4>Connect Claude</h4>
    <p class="note">Once you're in a kitchen, you can connect your own Claude account so Claude can find recipes, plan your week and save straight into the app.</p>`;
  $("#sheet").innerHTML = `<div class="scrim" data-scrim><article class="sheet kitchen" role="dialog" aria-modal="true" aria-label="Kitchen">
    <button class="close" data-closesheet aria-label="Close">×</button>${body}${KC_ERR ? `<p class="err" role="alert">${esc2(KC_ERR)}</p>` : ""}</article></div>`;
}
function kitchenBtn() { const b = document.getElementById("kbtn"); if (b) b.innerHTML = KCODE ? `<i class="kdot"></i>Kitchen · ${KCODE.slice(0, 4)}` : "👥 Link up with a code"; }
async function kStart() {
  KC_BUSY = true; KC_ERR = ""; renderKitchen();
  try {
    const r = await fetch(`${API_BASE}/api/kitchens`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ state: { ...S, saved: true }, custom: CUSTOM }) });
    const x = await r.json(); if (!r.ok || !x.code) throw new Error(x.error || "Couldn't start a kitchen");
    kcSave(x.code); location.reload();
  } catch (e) { KC_BUSY = false; KC_ERR = "Couldn't reach the server. Check your connection and try again."; renderKitchen(); }
}
async function kJoin(raw) {
  const s = String(raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (s.length !== 12) { KC_ERR = "Kitchen codes have 12 letters and numbers, like K7QM-4XPA-9RTE."; renderKitchen(); return; }
  const code = `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
  KC_BUSY = true; KC_ERR = ""; renderKitchen();
  try {
    const x = await (await fetch(`${API_BASE}/api/k/${code}`)).json();
    if (!x.exists) { KC_BUSY = false; KC_ERR = "No kitchen with that code. Check it with whoever sent it."; renderKitchen(); return; }
    kcSave(code); try { localStorage.removeItem(LS); localStorage.removeItem(LSC); } catch (e) {}
    location.reload();
  } catch (e) { KC_BUSY = false; KC_ERR = "Couldn't reach the server. Check your connection and try again."; renderKitchen(); }
}
document.addEventListener("click", e => {
  if (e.target.closest("#kbtn")) { KC_ERR = ""; renderKitchen(); return; }
  if (e.target.closest("#kstart")) { kStart(); return; }
  const cp = e.target.closest("[data-kcopy]");
  if (cp) { const t = cp.dataset.kcopy; (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(() => toast("Copied"), () => fallbackCopy(t)); return; }
  const lv = e.target.closest("#kleave");
  if (lv) { if (!lv.dataset.armed) { lv.dataset.armed = "1"; lv.textContent = "Tap again to leave"; return; } kcSave(null); location.reload(); }
});
document.addEventListener("submit", e => { if (e.target.id === "kjoin") { e.preventDefault(); kJoin(document.getElementById("kcodein").value); } });
document.addEventListener("DOMContentLoaded", kitchenBtn);
if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("./sw.js").catch(() => {});
