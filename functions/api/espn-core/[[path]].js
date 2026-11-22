// Fallback proxy for ESPN's core API: some of its responses come back without CORS headers, which the browser
// blocks. live.html tries ESPN directly first and falls back to this. Only college-football event paths are allowed.
export async function onRequest({ params }) {
  const path = Array.isArray(params.path) ? params.path.join("/") : params.path || "";
  if (!/^events\/\d+\/competitions\/\d+\/(status|situation|plays\/\d+)$/.test(path))
    return new Response(JSON.stringify({ error: "path not allowed" }), { status: 404, headers: { "Content-Type": "application/json" } });
  const r = await fetch("https://sports.core.api.espn.com/v2/sports/football/leagues/college-football/" + path, { headers: { Accept: "application/json" } });
  return new Response(await r.text(), { status: r.status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
