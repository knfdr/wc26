// Legacy endpoint used by the WC26 "Find on Kalshi" button.
// GET  /api/kalshi?ticker=...                      -> market
// POST /api/kalshi {ticker, side:"yes"|"no", count, price (cents)} -> buy limit order
// Uses the v2 signed API; the old /portfolio/orders endpoint returns 410 since June 2026.
import { kalshiFetch, checkOrder, hasCredentials } from "../../lib/kalshi.js";

const H = { "Content-Type": "application/json", "Cache-Control": "no-store" };

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  try {
    if (request.method === "GET") {
      const ticker = url.searchParams.get("ticker");
      if (!ticker || !/^KX[A-Z0-9.-]+$/.test(ticker)) return new Response(JSON.stringify({ error: "Missing ticker" }), { status: 400, headers: H });
      const r = await kalshiFetch(env, "GET", "/markets/" + ticker, null, { sign: hasCredentials(env) });
      return new Response(r.text, { status: r.status, headers: H });
    }
    if (request.method === "POST") {
      if (!hasCredentials(env)) return new Response(JSON.stringify({ error: "Kalshi credentials not configured" }), { status: 503, headers: H });
      const { ticker, side, count, price } = await request.json();
      const cents = Math.round(Number(price));
      // buying NO at c == selling YES at (100 - c)
      const order = {
        ticker, side: side === "yes" ? "bid" : "ask",
        count: String(Math.max(1, Math.floor(Number(count)))),
        price: ((side === "yes" ? cents : 100 - cents) / 100).toFixed(2),
        time_in_force: "good_till_canceled",
        self_trade_prevention_type: "taker_at_cross",
        client_order_id: "ss-" + crypto.randomUUID(),
      };
      const err = checkOrder(env, order);
      if (err) return new Response(JSON.stringify({ error: err }), { status: 400, headers: H });
      const r = await kalshiFetch(env, "POST", "/portfolio/events/orders", order);
      let data; try { data = JSON.parse(r.text); } catch (e) { data = { raw: r.text }; }
      // keep the old response shape the page expects ({order: ...})
      if (r.status < 300) data = { order: data };
      return new Response(JSON.stringify(data), { status: r.status, headers: H });
    }
    return new Response("Method not allowed", { status: 405 });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e.message || e) }), { status: 500, headers: H });
  }
}
