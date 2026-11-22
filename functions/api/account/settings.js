// The signed-in person's own bet-sizing settings (base bets, grade bars, ...), so nobody runs on anyone else's.
//   GET -> { settings: {...} | null }   PUT { ...settings } -> saved
// The owner's settings used to live in the shared gist; until the owner saves here once, they're read from there.
import { readSettings, writeSettings } from "../../../lib/accounts.js";

const GIST_ID = "8a76d2b09c709882e4364528a0152ccc", GIST_SETTINGS = "sharpsim_settings.json";
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

async function gistSettings(env) {
  if (!env.GITHUB_TOKEN) return null;
  const r = await fetch(`https://api.github.com/gists/${GIST_ID}`, { headers: { Authorization: `token ${env.GITHUB_TOKEN}`, Accept: "application/vnd.github.v3+json", "User-Agent": "wc26-proxy" } });
  if (!r.ok) return null;
  const f = (await r.json()).files?.[GIST_SETTINGS];
  try { return f && f.content ? JSON.parse(f.content) : null; } catch (e) { return null; }
}

export async function onRequest({ request, env, data }) {
  const user = data.user;
  if (request.method === "GET") {
    let s = await readSettings(env, user.email);
    if (!s && user.role === "owner") s = await gistSettings(env);
    return json({ settings: s || null });
  }
  if (request.method === "PUT") {
    if (!env.USERS) return json({ error: "Saving settings isn't set up on this site yet (USERS KV binding)." }, 503);
    const text = await request.text();
    if (text.length > 20000) return json({ error: "Settings too large" }, 413);
    let s; try { s = JSON.parse(text); } catch (e) { return json({ error: "Bad JSON" }, 400); }
    if (!s || typeof s !== "object" || Array.isArray(s)) return json({ error: "Bad settings" }, 400);
    await writeSettings(env, user.email, s);
    return json({ ok: true });
  }
  return new Response("Method not allowed", { status: 405 });
}
