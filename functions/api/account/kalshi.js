// The signed-in person's own Kalshi API key.
//   GET     -> { storage, connected, source: "own"|"site"|null, keyIdHint, env, maxOrderDollars, tradingEnabled }
//   PUT     { keyId, privateKey, env: "prod"|"demo", maxOrderDollars } -> checks the key against Kalshi, then saves it encrypted
//   PATCH   { maxOrderDollars } -> change the per-bet cap on the saved key
//   DELETE  -> forget the key
// Private keys are write-only: they're never sent back.
import { kalshiFetch } from "../../../lib/kalshi.js";
import { storageReady, savedKalshi, saveKalshi, deleteKalshi, kalshiEnvFor, DEFAULT_MAX_ORDER, MAX_ORDER_LIMIT } from "../../../lib/accounts.js";

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
const hint = (id) => id ? "…" + String(id).slice(-4) : null;
const cap = (v) => { const n = Math.round(Number(v)); return n >= 1 && n <= MAX_ORDER_LIMIT ? n : null; };

async function status(env, user) {
  const k = await kalshiEnvFor(env, user);
  return { storage: storageReady(env), connected: !!k, source: k ? k.source : null, keyIdHint: k ? hint(k.KALSHI_API_KEY_ID) : null,
    env: k ? k.KALSHI_ENV : null, maxOrderDollars: k ? parseFloat(k.KALSHI_MAX_ORDER_DOLLARS) : null,
    tradingEnabled: env.KALSHI_TRADING_ENABLED === "1", maxOrderLimit: MAX_ORDER_LIMIT };
}

export async function onRequest({ request, env, data }) {
  const user = data.user;
  const method = request.method.toUpperCase();
  try {
    if (method === "GET") return json(await status(env, user));
    if (!storageReady(env)) return json({ error: "Saving keys isn't set up on this site yet (USERS KV binding / USER_KEYS_SECRET)." }, 503);

    if (method === "DELETE") { await deleteKalshi(env, user.email); return json(await status(env, user)); }

    const body = await request.json().catch(() => ({}));
    if (method === "PATCH") {
      const own = await savedKalshi(env, user.email);
      if (!own) return json({ error: "No saved key to change." }, 400);
      const m = cap(body.maxOrderDollars);
      if (!m) return json({ error: `Per-bet cap must be $1 to $${MAX_ORDER_LIMIT}.` }, 400);
      await saveKalshi(env, user.email, { ...own, maxOrderDollars: m });
      return json(await status(env, user));
    }
    if (method === "PUT") {
      const keyId = String(body.keyId || "").trim();
      const privateKey = String(body.privateKey || "").trim();
      const kenv = body.env === "demo" ? "demo" : "prod";
      const m = body.maxOrderDollars == null || body.maxOrderDollars === "" ? DEFAULT_MAX_ORDER : cap(body.maxOrderDollars);
      if (!/^[A-Za-z0-9-]{8,80}$/.test(keyId)) return json({ error: "That doesn't look like a Kalshi API key ID." }, 400);
      if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(privateKey) || privateKey.length > 8000) return json({ error: "Paste the whole private key file, including the BEGIN and END lines." }, 400);
      if (!m) return json({ error: `Per-bet cap must be $1 to $${MAX_ORDER_LIMIT}.` }, 400);
      // Prove the key works (and belongs to a real account) before saving it.
      let r;
      try { r = await kalshiFetch({ KALSHI_API_KEY_ID: keyId, KALSHI_PRIVATE_KEY: privateKey, KALSHI_ENV: kenv }, "GET", "/portfolio/balance", null); }
      catch (e) { return json({ error: "Couldn't read that private key: " + String(e.message || e) }, 400); }
      if (r.status !== 200) return json({ error: `Kalshi (${kenv}) rejected the key (HTTP ${r.status}). Check the key ID, the private key, and prod vs demo.` }, 400);
      await saveKalshi(env, user.email, { keyId, privateKey, env: kenv, maxOrderDollars: m, savedAt: new Date().toISOString() });
      return json(await status(env, user));
    }
    return json({ error: "Method not allowed" }, 405);
  } catch (e) {
    return json({ error: String(e && e.message || e) }, 500);
  }
}
