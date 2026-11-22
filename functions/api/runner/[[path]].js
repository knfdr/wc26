// Proxy from the site (already behind the SITE_PASSWORD middleware) to the server-side runner Worker.
// Env (Pages secrets): RUNNER_URL (e.g. https://wc26-runner.<account>.workers.dev), RUNNER_TOKEN (shared with the Worker).
export async function onRequest({ request, env, params }) {
  if (!env.RUNNER_URL || !env.RUNNER_TOKEN) return new Response(JSON.stringify({ error: "runner not configured (RUNNER_URL / RUNNER_TOKEN)" }), { status: 503, headers: { "Content-Type": "application/json" } });
  const path = Array.isArray(params.path) ? params.path.join("/") : (params.path || "status");
  if (!/^(status|account|start|stop|kill|config|reset-paper|manage|settings)$/.test(path)) return new Response(JSON.stringify({ error: "unknown route" }), { status: 404, headers: { "Content-Type": "application/json" } });
  const url = new URL(request.url);
  const r = await fetch(env.RUNNER_URL.replace(/\/$/, "") + "/" + path + url.search, {
    method: request.method,
    headers: { "Content-Type": "application/json", "X-Runner-Token": env.RUNNER_TOKEN },
    body: request.method === "POST" ? await request.text() : undefined,
  });
  return new Response(await r.text(), { status: r.status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
