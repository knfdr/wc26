const GIST_ID = "8a76d2b09c709882e4364528a0152ccc";

export async function onRequest(context) {
  const token = context.env.GITHUB_TOKEN;
  if (!token) return new Response("GITHUB_TOKEN not configured", { status: 500 });

  const apiUrl = `https://api.github.com/gists/${GIST_ID}`;
  const headers = {
    Authorization: `token ${token}`,
    Accept: "application/vnd.github.v3+json",
    "Content-Type": "application/json",
    "User-Agent": "wc26-proxy",
  };

  if (context.request.method === "GET") {
    const resp = await fetch(apiUrl, { headers });
    const data = await resp.text();
    return new Response(data, { status: resp.status, headers: { "Content-Type": "application/json" } });
  }

  if (context.request.method === "PATCH") {
    const body = await context.request.text();
    const resp = await fetch(apiUrl, { method: "PATCH", headers, body });
    const data = await resp.text();
    return new Response(data, { status: resp.status, headers: { "Content-Type": "application/json" } });
  }

  return new Response("Method not allowed", { status: 405 });
}
