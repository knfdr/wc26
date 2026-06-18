export async function onRequest(context) {
  const { request, next, env } = context;
  const url = new URL(request.url);

  // Never gate the login page itself
  if (url.pathname === "/login") return next();

  const cookie = request.headers.get("Cookie") || "";
  const token = (cookie.split(";").map(c => c.trim()).find(c => c.startsWith("sharp-auth=")) || "").split("=")[1];

  if (token === env.SITE_PASSWORD) return next();

  return Response.redirect(new URL("/login", request.url).toString(), 302);
}
