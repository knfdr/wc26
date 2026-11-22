// Every request: work out who is signed in (Cloudflare Access, see lib/auth.js), refuse anyone not invited, keep the
// owner's Kalshi account owner-only, and add a small "signed in as · sign out" badge to HTML pages.
import { currentUser, ownerOnly, devMode, accessConfigured } from "../lib/auth.js";

const json = (obj, status) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function page(status, title, body) {
  return new Response(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sharp Sim</title><style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#070b14;color:#dde5f0;font-family:'IBM Plex Mono','Courier New',monospace;padding:16px;box-sizing:border-box}
.c{max-width:420px;background:#101d30;border:1px solid #1a2a3e;border-radius:8px;padding:24px}h1{font-size:18px;margin:0 0 10px;color:#e8c547}p{font-size:12px;line-height:1.6;color:#9fb0c6;margin:0 0 10px}a{color:#38bdf8}</style></head>
<body><div class="c"><h1>${esc(title)}</h1>${body}</div></body></html>`, { status, headers: { "Content-Type": "text/html;charset=UTF-8", "Cache-Control": "no-store" } });
}

function badge(user, signOut) {
  const owner = user.role === "owner";
  return `<div id="ss-auth" style="position:fixed;right:10px;bottom:10px;z-index:2147483000;display:flex;gap:8px;align-items:center;max-width:calc(100vw - 20px);box-sizing:border-box;background:#0b1424ee;border:1px solid #1a2a3e;border-radius:6px;padding:5px 9px;font:10px/1.3 'IBM Plex Mono','Courier New',monospace;color:#9fb0c6">`
    + `<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(user.email)}</span>`
    + `<span style="color:${owner ? "#e8c547" : "#38bdf8"};letter-spacing:1px">${owner ? "OWNER" : "VIEW ONLY"}</span>`
    + `<a href="${signOut}" style="color:#dde5f0;text-decoration:underline;white-space:nowrap">Sign out</a></div>`;
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

  if (url.pathname === "/api/me") return json({ email: user.email, role: user.role, signOut }, 200);
  if (url.pathname === "/logout") return Response.redirect(new URL(signOut, url).toString(), 302);
  if (url.pathname === "/login") return Response.redirect(new URL("/", url).toString(), 302); // old bookmark

  context.data.user = user;
  const res = await next();
  if (!(res.headers.get("Content-Type") || "").includes("text/html")) return res;

  // Pages are now per-person (badge, role), so they must not be cached and shared.
  const out = new HTMLRewriter()
    .on("head", { element(el) { el.prepend(`<script>window.SS_USER=${JSON.stringify({ email: user.email, role: user.role }).replace(/</g, "\\u003c")}</script>`, { html: true }); } })
    .on("body", { element(el) { el.append(badge(user, signOut), { html: true }); } })
    .transform(res);
  const h = new Headers(out.headers);
  h.set("Cache-Control", "private, no-store");
  h.delete("ETag");
  return new Response(out.body, { status: out.status, statusText: out.statusText, headers: h });
}
