// /account: the signed-in person connects (or removes) their own Kalshi API key for one-tap bets.
// Served from functions/ so it stays independent of the redesigned site pages. Talks to /api/account/kalshi.
export function onRequest({ data }) {
  const u = data.user;
  const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  return new Response(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sharp Sim · Account</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700;800&family=Geist+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/css/sharp.css">
<style>
.acct{max-width:620px}.acct .field{width:100%}.acct textarea.field{min-height:130px;resize:vertical;font-family:var(--mono);font-size:12px;padding:10px 12px;line-height:1.4}
.acct label.label{display:block;margin:14px 0 6px}.acct ol{margin:8px 0 0;padding-left:18px;color:var(--text-2);font-size:13px;line-height:1.6}
.ok{color:var(--strong);font-weight:600}.bad-t{color:var(--avoid)}.grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px}@media(max-width:480px){.grid2{grid-template-columns:1fr}}
</style></head><body>
<main class="ss-main acct">
<p class="small"><a href="/" class="text-2">← Sharp Sim</a></p>
<div class="ss-head"><div class="ss-eyebrow">Signed in as ${esc(u.email)}${u.role === "owner" ? " · owner" : ""}</div><h1 class="ss-h1">Your account</h1></div>

<div class="card"><div class="ss-h2" style="margin-top:0">One-tap bets on Kalshi</div><div id="status" class="small text-2">Checking…</div><div id="manage"></div></div>

<div class="card" id="connect" hidden><div class="ss-h2" style="margin-top:0" id="connectTitle">Connect your Kalshi account</div>
<p class="small text-2">Optional. Without a key you still see every pick, grade and price, and can bet them anywhere you like. With your own key, the Bet buttons place orders on <b>your</b> Kalshi account. Your key is stored encrypted, never shown again, and used only for your bets.</p>
<ol><li>On kalshi.com go to Account &amp; security → API keys → Create key.</li><li>Kalshi shows a key ID and downloads a private key file (.key / .pem).</li><li>Paste both below. We check the key with Kalshi before saving it.</li></ol>
<form id="f">
<label class="label" for="keyId">API key ID</label><input class="field" id="keyId" autocomplete="off" spellcheck="false" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx">
<label class="label" for="pk">Private key</label><textarea class="field" id="pk" spellcheck="false" placeholder="-----BEGIN RSA PRIVATE KEY-----&#10;…&#10;-----END RSA PRIVATE KEY-----"></textarea>
<div class="tiny muted" style="margin-top:6px">or load the file: <input type="file" id="file" accept=".key,.pem,.txt"></div>
<div class="grid2"><div><label class="label" for="kenv">Account</label><select class="field" id="kenv"><option value="prod">Real money (prod)</option><option value="demo">Demo (practice)</option></select></div>
<div><label class="label" for="cap">Max per bet ($)</label><input class="field" id="cap" type="number" min="1" step="1" value="25"></div></div>
<div class="wrap-row" style="margin-top:16px"><button type="submit" class="btn btn-primary" id="save">Check and save key</button><span id="msg" class="small text-2"></span></div>
</form></div>
</main>
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
    const b = document.createElement("span"); b.className = "ok"; b.textContent = "Connected";
    st.append(b, text(" · key " + s.keyIdHint + " · " + (s.env === "demo" ? "demo account" : "real-money account") + " · max $" + s.maxOrderDollars + " per bet"));
    if (s.source === "site") st.append(document.createElement("br"), text("Using the site's server key (owner only). Save your own below to replace it."));
    if (!s.tradingEnabled) { const p = document.createElement("div"); p.className = "note bad"; p.style.marginTop = "10px"; p.textContent = "Betting is switched off site-wide right now, so orders won't be sent."; st.append(p); }
    if (s.source === "own") {
      const row = document.createElement("div"); row.className = "wrap-row"; row.style.marginTop = "14px";
      const cap = document.createElement("input"); cap.type = "number"; cap.min = 1; cap.max = s.maxOrderLimit; cap.value = s.maxOrderDollars; cap.className = "field"; cap.style.width = "110px"; cap.setAttribute("aria-label", "Max per bet in dollars");
      const save = document.createElement("button"); save.className = "btn btn-sm"; save.textContent = "Update max per bet";
      save.onclick = async () => { try { render(await api("PATCH", { maxOrderDollars: +cap.value })); } catch (e) { alert(e.message); } };
      const del = document.createElement("button"); del.className = "btn btn-sm"; del.textContent = "Remove my key";
      del.onclick = async () => { if (!confirm("Remove your Kalshi key from Sharp Sim? Bet buttons will disappear until you add one again.")) return; try { render(await api("DELETE")); } catch (e) { alert(e.message); } };
      row.append(cap, save, del); m.append(row);
    }
  } else {
    st.textContent = "No Kalshi key on your account. You'll see every pick and price, without Bet buttons.";
  }
  $("connect").hidden = !s.storage || s.source === "own";
  $("connectTitle").textContent = s.source === "site" ? "Save your own Kalshi key" : "Connect your Kalshi account";
  $("cap").max = s.maxOrderLimit || 1000;
  if (!s.storage) { const p = document.createElement("div"); p.className = "note warn"; p.style.marginTop = "10px"; p.textContent = "Saving keys isn't set up on this site yet."; st.append(p); }
}
$("file").onchange = async (e) => { const f = e.target.files[0]; if (f) $("pk").value = (await f.text()).trim(); };
$("f").onsubmit = async (e) => {
  e.preventDefault(); $("save").disabled = true; $("msg").className = "small text-2"; $("msg").textContent = "Checking with Kalshi…";
  try {
    const s = await api("PUT", { keyId: $("keyId").value, privateKey: $("pk").value, env: $("kenv").value, maxOrderDollars: $("cap").value });
    $("pk").value = ""; $("keyId").value = ""; $("msg").textContent = ""; render(s);
  } catch (err) { $("msg").className = "small bad-t"; $("msg").textContent = err.message; }
  $("save").disabled = false;
};
api("GET").then(render).catch(e => { $("status").className = "small bad-t"; $("status").textContent = e.message; });
</script></body></html>`, { headers: { "Content-Type": "text/html;charset=UTF-8", "Cache-Control": "no-store" } });
}
