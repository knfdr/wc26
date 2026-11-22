// Local-dev stand-in for Cloudflare Access: pick a throwaway email to act as. The middleware only routes here when
// ACCESS_AUD is unset and the request is to localhost; anywhere else this returns 404.
import { devMode } from "../lib/auth.js";

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  if (!devMode(env, url)) return new Response("Not found", { status: 404 });
  if (url.searchParams.has("out")) return new Response(null, { status: 302, headers: { Location: "/dev-login", "Set-Cookie": "dev-email=; Path=/; Max-Age=0" } });
  if (request.method === "POST") {
    const email = String((await request.formData()).get("email") || "").trim().toLowerCase();
    return new Response(null, { status: 302, headers: { Location: "/", "Set-Cookie": `dev-email=${encodeURIComponent(email)}; Path=/; HttpOnly; SameSite=Strict` } });
  }
  return new Response(`<!DOCTYPE html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Dev sign-in</title>
<body style="background:#070b14;color:#dde5f0;font-family:monospace;padding:24px"><h3>Local dev sign-in (no Cloudflare Access here)</h3>
<form method="POST"><input name="email" placeholder="owner@example.test" style="padding:8px;width:260px"> <button>Act as</button></form></body>`,
    { headers: { "Content-Type": "text/html;charset=UTF-8" } });
}
