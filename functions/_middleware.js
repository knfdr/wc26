// Every request: work out who is signed in (Cloudflare Access, see lib/auth.js), refuse anyone not invited, keep the
// owner's auto trader owner-only, block cross-site writes, and add a small "signed in as · account · sign out" badge to
// HTML pages. Kalshi routes sign with each person's own key (lib/accounts.js), never the owner's for anyone else.
import { currentUser, ownerOnly, devMode, accessConfigured } from "../lib/auth.js";

const json = (obj, status) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function page(status, title, body) {
  return new Response(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sharp Sim</title><style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#070b14;color:#dde5f0;font-family:'IBM Plex Mono','Courier New',monospace;padding:16px;box-sizing:border-box}
.c{max-width:420px;background:#101d30;border:1px solid #1a2a3e;border-radius:8px;padding:24px}h1{font-size:18px;margin:0 0 10px;color:#e8c547}p{font-size:12px;line-height:1.6;color:#9fb0c6;margin:0 0 10px}a{color:#38bdf8}</style></head>
<body><div class="c"><h1>${esc(title)}</h1>${body}</div></body></html>`, { status, headers: { "Content-Type": "text/html;charset=UTF-8", "Cache-Control": "no-store" } });
}

// Badge styles use the design system's tokens (css/sharp.css), so it follows the light/dark theme; the fallbacks
// are the dark theme, for any page that doesn't load the stylesheet. The tiny script applies the saved theme
// choice (js/ui.js's "sharp_theme") on pages that don't run ui.js.
const BADGE_HEAD = `<style id="ss-auth-css">
#ss-auth{position:fixed;right:12px;bottom:calc(12px + env(safe-area-inset-bottom));z-index:60;display:flex;gap:10px;align-items:center;max-width:calc(100vw - 24px);box-sizing:border-box;
background:color-mix(in srgb,var(--surface,#13161b) 92%,transparent);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);
border:1px solid var(--line-strong,rgba(255,255,255,.14));border-radius:999px;padding:6px 12px;box-shadow:var(--shadow,0 8px 24px rgba(0,0,0,.25));
font:500 12px/1.3 var(--font,system-ui,-apple-system,sans-serif);color:var(--muted,#7f8896)}
#ss-auth .ss-auth-email{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
#ss-auth .ss-auth-role{font-size:10px;font-weight:700;letter-spacing:.06em;color:var(--text,#eef1f5);background:var(--surface-3,#232833);border-radius:999px;padding:2px 7px}
#ss-auth a{color:var(--text-2,#b4bcc8);text-decoration:none;white-space:nowrap;font-weight:600}
#ss-auth a:hover{color:var(--text,#eef1f5);text-decoration:underline}
@media (max-width:480px){#ss-auth .ss-auth-email{max-width:38vw}}
@media print{#ss-auth{display:none}}
</style><script>try{var t=localStorage.getItem("sharp_theme");if(t==="dark"||t==="light")document.documentElement.setAttribute("data-theme",t)}catch(e){}</script>`;

function badge(user, signOut) {
  return `<div id="ss-auth" role="navigation" aria-label="Account">`
    + `<span class="ss-auth-email" title="${esc(user.email)}">${esc(user.email)}</span>`
    + (user.role === "owner" ? `<span class="ss-auth-role">OWNER</span>` : "")
    + `<a href="/account">Account</a><a href="${signOut}">Sign out</a></div>`;
}

export async function onRequest(context) {
  const { request, next, env } = context;
  const url = new URL(request.url);
  const dev = devMode(env, url);
  const signOut = dev ? "/dev-login?out=1" : "/cdn-cgi/access/logout";

  if (dev && url.pathname === "/dev-login") return next(); // local-only test login (functions/dev-login.js)
  if (!dev && !accessConfigured(env)) return page(503, "Sign-in isn't set up", "<p>This site's Cloudflare Access settings (ACCESS_TEAM_DOMAIN, ACCESS_AUD) are missing, so nobody can be let in.</p>");

  const user = await currentUser(request, env);
  const api = url.pathname.startsWith("/api/");
  if (!user) {
    if (dev) return Response.redirect(new URL("/dev-login", url).toString(), 302);
    return api ? json({ error: "Not signed in" }, 401)
      : page(401, "Please sign in", `<p>Your sign-in has expired or is missing.</p><p><a href="/">Sign in again</a></p>`);
  }
  if (!user.role) {
    return api ? json({ error: "Not invited" }, 403)
      : page(403, "Not invited", `<p>${esc(user.email)} isn't on this site's guest list. Ask the owner to add you.</p><p><a href="${signOut}">Sign out</a></p>`);
  }
  if (user.role !== "owner" && ownerOnly(request.method, url.pathname)) return json({ error: "Owner only" }, 403);
  // Writes (orders, key and settings changes) must come from this site's own pages.
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase())) {
    const origin = request.headers.get("Origin");
    if (origin && origin !== url.origin) return json({ error: "Cross-site request refused" }, 403);
  }

  if (url.pathname === "/api/me") return json({ email: user.email, role: user.role, signOut }, 200);
  if (url.pathname === "/logout") return Response.redirect(new URL(signOut, url).toString(), 302);
  if (url.pathname === "/login") return Response.redirect(new URL("/", url).toString(), 302); // old bookmark

  context.data.user = user;
  const res = await next();
  if (!(res.headers.get("Content-Type") || "").includes("text/html")) return res;

  // Pages are now per-person (badge, role), so they must not be cached and shared.
  const out = new HTMLRewriter()
    .on("head", { element(el) { el.prepend(`<script>window.SS_USER=${JSON.stringify({ email: user.email, role: user.role }).replace(/</g, "\\u003c")}</script>`, { html: true }); el.append(BADGE_HEAD, { html: true }); } })
    .on("body", { element(el) { el.append(badge(user, signOut), { html: true }); } })
    .transform(res);
  const h = new Headers(out.headers);
  h.set("Cache-Control", "private, no-store");
  h.delete("ETag");
  return new Response(out.body, { status: out.status, statusText: out.statusText, headers: h });
}
