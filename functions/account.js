// /account: the signed-in person connects (or removes) their own Kalshi API key for one-tap bets.
// Served from functions/ so it stays independent of the redesigned site pages. Talks to /api/account/kalshi.
export function onRequest({ data }) {
  const u = data.user;
  const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  return new Response(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sharp Sim · Account</title>
<style>
:root{--bg:#070b14;--card:#101d30;--border:#1a2a3e;--text:#dde5f0;--muted:#9fb0c6;--dim:#4b6280;--gold:#e8c547;--blue:#38bdf8;--green:#22c55e;--red:#ef4444}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:13px/1.55 'IBM Plex Mono','SF Mono','Courier New',monospace;padding:24px 16px 80px}
.w{max-width:560px;margin:0 auto}a{color:var(--blue)}h1{font-size:22px;margin:0 0 4px}h2{font-size:12px;letter-spacing:2px;color:var(--dim);text-transform:uppercase;margin:0 0 12px}
.sub{color:var(--muted);font-size:11px;margin-bottom:22px}.card{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:18px;margin-bottom:16px}
label{display:block;font-size:10px;letter-spacing:1.5px;color:var(--dim);text-transform:uppercase;margin:12px 0 6px}
input,select,textarea{width:100%;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--text);font:inherit;font-size:12px;padding:9px 11px}
textarea{min-height:120px;resize:vertical}button{background:var(--gold);color:var(--bg);border:0;border-radius:4px;font:inherit;font-weight:700;font-size:11px;letter-spacing:1.5px;padding:10px 14px;cursor:pointer;margin-top:14px}
button.ghost{background:transparent;color:var(--text);border:1px solid var(--border)}button:disabled{opacity:.5;cursor:default}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}.ok{color:var(--green)}.bad{color:var(--red)}.note{color:var(--muted);font-size:11px}
ol{padding-left:18px;margin:6px 0 0;color:var(--muted);font-size:11px}li{margin-bottom:4px}
</style></head><body><div class="w">
<p><a href="/">← Sharp Sim</a></p>
<h1>Your account</h1>
<div class="sub">Signed in as ${esc(u.email)}${u.role === "owner" ? " · owner" : ""}</div>

<div class="card"><h2>One-tap bets on Kalshi</h2><div id="status" class="note">Checking…</div><div id="manage"></div></div>

<div class="card" id="connect" hidden><h2 id="connectTitle">Connect your Kalshi account</h2>
<p class="note">Optional. Without a key you still see every pick, grade and price, and can bet them anywhere you like. With your own key, the BET buttons place orders on <b>your</b> Kalshi account. Your key is stored encrypted, is never shown again, and is used only for your bets.</p>
<ol><li>On kalshi.com go to Account &amp; security → API keys → Create key.</li><li>Kalshi shows a key ID and downloads a private key file (.key / .pem).</li><li>Paste both below. We check the key with Kalshi before saving it.</li></ol>
<form id="f">
<label for="keyId">API key ID</label><input id="keyId" autocomplete="off" spellcheck="false" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx">
<label for="pk">Private key</label><textarea id="pk" spellcheck="false" placeholder="-----BEGIN RSA PRIVATE KEY-----&#10;…&#10;-----END RSA PRIVATE KEY-----"></textarea>
<div class="note" style="margin-top:6px">or load the file: <input type="file" id="file" accept=".key,.pem,.txt" style="width:auto;border:0;padding:4px 0"></div>
<div class="row"><div style="flex:1;min-width:140px"><label for="kenv">Account</label><select id="kenv"><option value="prod">Real money (prod)</option><option value="demo">Demo (practice)</option></select></div>
<div style="flex:1;min-width:140px"><label for="cap">Max per bet ($)</label><input id="cap" type="number" min="1" step="1" value="25"></div></div>
<button type="submit" id="save">Check and save key</button> <span id="msg" class="note"></span>
</form></div>
</div>
<script>
const $ = (id) => document.getElementById(id);
const api = async (method, body) => {
  const r = await fetch("/api/account/kalshi", { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({ error: "HTTP " + r.status }));
  if (!r.ok) throw new Error(d.error || ("HTTP " + r.status));
  return d;
};
const text = (s) => document.createTextNode(s);
function render(s) {
  const st = $("status"), m = $("manage"); m.replaceChildren(); st.replaceChildren();
  if (s.connected) {
    const b = document.createElement("b"); b.className = "ok"; b.textContent = "Connected";
    st.append(b, text(" · key " + s.keyIdHint + " · " + (s.env === "demo" ? "demo account" : "real-money account") + " · max $" + s.maxOrderDollars + " per bet"));
    if (s.source === "site") st.append(document.createElement("br"), text("Using the site's server key (owner only). Save your own below to replace it."));
    if (!s.tradingEnabled) { const p = document.createElement("div"); p.className = "bad"; p.style.marginTop = "8px"; p.textContent = "Betting is switched off site-wide right now, so orders won't be sent."; st.append(p); }
    if (s.source === "own") {
      const row = document.createElement("div"); row.className = "row";
      const cap = document.createElement("input"); cap.type = "number"; cap.min = 1; cap.max = s.maxOrderLimit; cap.value = s.maxOrderDollars; cap.style.width = "110px"; cap.style.marginTop = "14px"; cap.setAttribute("aria-label", "Max per bet in dollars");
      const save = document.createElement("button"); save.className = "ghost"; save.textContent = "Update max per bet";
      save.onclick = async () => { try { render(await api("PATCH", { maxOrderDollars: +cap.value })); } catch (e) { alert(e.message); } };
      const del = document.createElement("button"); del.className = "ghost"; del.textContent = "Remove my key";
      del.onclick = async () => { if (!confirm("Remove your Kalshi key from Sharp Sim? BET buttons will disappear until you add one again.")) return; try { render(await api("DELETE")); } catch (e) { alert(e.message); } };
      row.append(cap, save, del); m.append(row);
    }
  } else {
    st.textContent = "No Kalshi key on your account. You'll see every pick and price, without BET buttons.";
  }
  $("connect").hidden = !s.storage || s.source === "own";
  $("connectTitle").textContent = s.source === "site" ? "Save your own Kalshi key" : "Connect your Kalshi account";
  $("cap").max = s.maxOrderLimit || 1000;
  if (!s.storage) { const p = document.createElement("div"); p.className = "note"; p.style.marginTop = "8px"; p.textContent = "Saving keys isn't set up on this site yet."; st.append(p); }
}
$("file").onchange = async (e) => { const f = e.target.files[0]; if (f) $("pk").value = (await f.text()).trim(); };
$("f").onsubmit = async (e) => {
  e.preventDefault(); $("save").disabled = true; $("msg").className = "note"; $("msg").textContent = "Checking with Kalshi…";
  try {
    const s = await api("PUT", { keyId: $("keyId").value, privateKey: $("pk").value, env: $("kenv").value, maxOrderDollars: $("cap").value });
    $("pk").value = ""; $("keyId").value = ""; $("msg").textContent = ""; render(s);
  } catch (err) { $("msg").className = "bad"; $("msg").textContent = err.message; }
  $("save").disabled = false;
};
api("GET").then(render).catch(e => { $("status").className = "bad"; $("status").textContent = e.message; });
</script></body></html>`, { headers: { "Content-Type": "text/html;charset=UTF-8", "Cache-Control": "no-store" } });
}
