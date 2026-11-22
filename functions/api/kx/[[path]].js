// Signed Kalshi proxy: /api/kx/<kalshi path>  ->  https://.../trade-api/v2/<kalshi path>
// Behind the site's password middleware. Only allow-listed paths; order writes pass a server-side guard.
import { kalshiFetch, checkOrder, hasCredentials } from "../../../lib/kalshi.js";

const PUBLIC_GET = [/^\/markets(\/[A-Z0-9.-]+(\/orderbook|\/trades)?)?$/, /^\/markets\/trades$/, /^\/events(\/[A-Z0-9.-]+)?$/,
  /^\/series(\/[A-Z0-9.-]+)?$/, /^\/exchange\/status$/, /^\/milestones(\/[\w-]+)?$/, /^\/live_data\/milestone\/[\w-]+(\/game_stats)?$/];
const PRIVATE_GET = [/^\/portfolio\/(balance|positions|fills|orders|settlements)$/, /^\/portfolio\/events\/orders\/[\w-]+$/];
const ORDER_CREATE = /^\/portfolio\/events\/orders$/;
const ORDER_CANCEL = /^\/portfolio\/events\/orders\/[\w-]+$/;

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
const pass = (r) => new Response(r.text, { status: r.status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

export async function onRequest({ request, env, params }) {
  const url = new URL(request.url);
  const segs = Array.isArray(params.path) ? params.path : (params.path ? [params.path] : []);
  const path = "/" + segs.join("/");
  const qs = url.search || "";
  const method = request.method.toUpperCase();
  const creds = hasCredentials(env);

  try {
    if (path === "/_status" && method === "GET") {
      return json({ credentials: creds, env: (env.KALSHI_ENV || "prod").toLowerCase(),
        tradingEnabled: env.KALSHI_TRADING_ENABLED === "1", maxOrderDollars: parseFloat(env.KALSHI_MAX_ORDER_DOLLARS || "25") });
    }
    if (method === "GET") {
      if (PUBLIC_GET.some(r => r.test(path))) return pass(await kalshiFetch(env, "GET", path + qs, null, { sign: creds }));
      if (PRIVATE_GET.some(r => r.test(path))) {
        if (!creds) return json({ error: "Kalshi credentials not configured" }, 503);
        return pass(await kalshiFetch(env, "GET", path + qs, null));
      }
      return json({ error: "Path not allowed" }, 403);
    }
    if (!creds) return json({ error: "Kalshi credentials not configured" }, 503);

    if (method === "POST" && ORDER_CREATE.test(path)) {
      const order = await request.json();
      const err = checkOrder(env, order);
      if (err) return json({ error: err }, 400);
      if (order.closing) {
        // A resting (GTC) exit can't use reduce_only, so verify it only closes what we hold.
        const pr = await kalshiFetch(env, "GET", "/portfolio/positions?ticker=" + encodeURIComponent(order.ticker), null);
        const pos = (JSON.parse(pr.text).market_positions || []).find(p => p.ticker === order.ticker);
        const held = pos ? parseFloat(pos.position_fp || pos.position || 0) : 0; // + YES, - NO
        const closes = (order.side === "ask" && held >= parseFloat(order.count)) || (order.side === "bid" && -held >= parseFloat(order.count));
        if (!closes) return json({ error: "Closing order larger than the position it closes" }, 400);
      }
      const { closing, ...clean } = order;
      if (!clean.self_trade_prevention_type) clean.self_trade_prevention_type = "taker_at_cross";
      if (!clean.client_order_id) clean.client_order_id = "ss-" + crypto.randomUUID();
      return pass(await kalshiFetch(env, "POST", path, clean));
    }
    if (method === "DELETE" && (ORDER_CANCEL.test(path) || path === "/portfolio/events/orders")) {
      return pass(await kalshiFetch(env, "DELETE", path + qs, null));
    }
    return json({ error: "Method/path not allowed" }, 405);
  } catch (e) {
    return json({ error: String(e && e.message || e) }, 500);
  }
}
