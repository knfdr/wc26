const KALSHI_BASE = "https://api.elections.kalshi.com/trade-api/v2";

export async function onRequest(ctx) {
  const { request, env } = ctx;
  const key = env.KALSHI_API_KEY || "84d93501-8b29-4a1f-a1e1-bb4eb36f6edf";
  const authHeaders = { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" };
  const cors = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }

  if (request.method === "GET") {
    const ticker = url.searchParams.get("ticker");
    if (!ticker) return new Response(JSON.stringify({ error: "Missing ticker" }), { status: 400, headers: cors });
    const r = await fetch(`${KALSHI_BASE}/markets/${ticker}`, { headers: authHeaders });
    const data = await r.json();
    return new Response(JSON.stringify(data), { status: r.status, headers: cors });
  }

  if (request.method === "POST") {
    const body = await request.json();
    const { ticker, side, count, price } = body;
    const order = {
      ticker,
      client_order_id: crypto.randomUUID(),
      action: "buy",
      side,
      count,
      type: "limit",
      ...(side === "yes" ? { yes_price: price } : { no_price: price }),
    };
    const r = await fetch(`${KALSHI_BASE}/portfolio/orders`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify(order),
    });
    const data = await r.json();
    return new Response(JSON.stringify(data), { status: r.status, headers: cors });
  }

  return new Response("Method not allowed", { status: 405, headers: cors });
}
