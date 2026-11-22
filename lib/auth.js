// Who is signed in, and what they may do.
//
// Login itself is Cloudflare Access (Zero Trust): Access sits in front of the whole Pages project and only lets the
// emails in its policy through. Every request that reaches us carries Access's signed token (Cf-Access-Jwt-Assertion
// header, or the CF_Authorization cookie). We verify that token here ourselves (signature against the team's public
// keys, audience, issuer, expiry) rather than trusting that Access is configured, then map the email to a role:
//   OWNER_EMAIL    the owner (comma-separated if more than one address)  -> "owner": everything
//   FRIEND_EMAILS  invited friends (comma-separated)                     -> "friend": picks, plus one-tap bets with
//                                                                            their own Kalshi key if they add one
// Anyone else who somehow gets an Access token is refused, so a too-wide Access policy can't let strangers in.
//
// Env (Pages > Settings > Variables): ACCESS_TEAM_DOMAIN (e.g. "sharpsim.cloudflareaccess.com"), ACCESS_AUD (the
// Access application's Audience tag), OWNER_EMAIL, FRIEND_EMAILS.
//
// Local dev (wrangler pages dev) has no Access in front of it. Only when ACCESS_AUD is unset AND the request is to
// localhost, the email comes from a `dev-email` cookie (set by /dev-login) or the AUTH_DEV_EMAIL binding.

const CERTS_TTL_MS = 60 * 60 * 1000;
let certsCache = { team: "", at: 0, keys: [] };

const b64urlBytes = (s) => {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
const b64urlJson = (s) => JSON.parse(new TextDecoder().decode(b64urlBytes(s)));

export const emailList = (v) => String(v || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);

export function cookie(request, name) {
  const hit = (request.headers.get("Cookie") || "").split(";").map(c => c.trim()).find(c => c.startsWith(name + "="));
  return hit ? decodeURIComponent(hit.slice(name.length + 1)) : "";
}

async function teamKeys(team, fetchImpl, force) {
  if (!force && certsCache.team === team && Date.now() - certsCache.at < CERTS_TTL_MS) return certsCache.keys;
  const r = await fetchImpl(`https://${team}/cdn-cgi/access/certs`);
  if (!r.ok) throw new Error("Access certs " + r.status);
  const keys = (await r.json()).keys || [];
  certsCache = { team, at: Date.now(), keys };
  return keys;
}

// Returns the token's payload if it is a valid, unexpired Access token for this application; otherwise null.
export async function verifyAccessJwt(token, { team, aud, fetchImpl = fetch, now = Date.now() }) {
  if (!token || !team || !aud) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  let header, payload;
  try { header = b64urlJson(parts[0]); payload = b64urlJson(parts[1]); } catch (e) { return null; }
  if (header.alg !== "RS256" || !header.kid) return null;

  let jwk = (await teamKeys(team, fetchImpl, false)).find(k => k.kid === header.kid);
  if (!jwk) jwk = (await teamKeys(team, fetchImpl, true)).find(k => k.kid === header.kid); // keys rotated
  if (!jwk) return null;
  const key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlBytes(parts[2]), new TextEncoder().encode(parts[0] + "." + parts[1]));
  if (!ok) return null;

  const secs = now / 1000;
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(aud)) return null;
  if (payload.iss !== `https://${team}`) return null;
  if (!(payload.exp > secs)) return null;
  if (payload.nbf && payload.nbf > secs + 60) return null;
  if (!payload.email) return null;
  return payload;
}

export function roleFor(env, email) {
  const e = String(email || "").toLowerCase();
  if (!e) return null;
  if (emailList(env.OWNER_EMAIL).includes(e)) return "owner";
  if (emailList(env.FRIEND_EMAILS).includes(e)) return "friend";
  return null;
}

export const isLocal = (url) => ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
export const accessConfigured = (env) => !!(env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD);
export const devMode = (env, url) => !env.ACCESS_AUD && isLocal(url);

// -> { email, role } | { email, role: null } (signed in but not invited) | null (not signed in / bad token)
export async function currentUser(request, env, fetchImpl = fetch) {
  const url = new URL(request.url);
  if (devMode(env, url)) {
    const email = (cookie(request, "dev-email") || env.AUTH_DEV_EMAIL || "").toLowerCase();
    return email ? { email, role: roleFor(env, email) } : null;
  }
  if (!accessConfigured(env)) return null;
  const token = request.headers.get("Cf-Access-Jwt-Assertion") || cookie(request, "CF_Authorization");
  const p = await verifyAccessJwt(token, { team: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_AUD, fetchImpl });
  return p ? { email: String(p.email).toLowerCase(), role: roleFor(env, p.email) } : null;
}

// Routes only the owner may use. Everything else is open to any invited (signed-in) person; Kalshi routes sign with
// that person's own key (lib/accounts.js), so they can't reach the owner's account.
export function ownerOnly(method, pathname) {
  const read = ["GET", "HEAD"].includes(method.toUpperCase());
  if (pathname === "/api/runner" || pathname.startsWith("/api/runner/")) return true; // the owner's auto trader
  if (pathname === "/api/gist") return !read;                                         // the shared pick record
  return false;
}
