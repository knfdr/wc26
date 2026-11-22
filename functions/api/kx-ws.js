// WebSocket relay: browser <-> this function <-> Kalshi's authenticated WebSocket.
// Browsers can't set Kalshi's signed handshake headers, so the function signs and pipes.
// Only subscription commands are forwarded upstream (the socket is read-only market/fill data).
import { openKalshiSocket, hasCredentials } from "../../lib/kalshi.js";
import { kalshiEnvFor } from "../../lib/accounts.js"; // signs with the signed-in person's own key only

const ALLOWED_CMDS = new Set(["subscribe", "unsubscribe", "update_subscription", "list_subscriptions"]);

export async function onRequest({ request, env: siteEnv, data }) {
  const env = (await kalshiEnvFor(siteEnv, data && data.user)) || { KALSHI_ENV: "prod" };
  if (request.headers.get("Upgrade") !== "websocket") {
    return new Response(JSON.stringify({ ok: true, credentials: hasCredentials(env), hint: "connect with a WebSocket" }),
      { status: hasCredentials(env) ? 426 : 503, headers: { "Content-Type": "application/json" } });
  }
  const pair = new WebSocketPair();
  const client = pair[0], server = pair[1];
  server.accept();
  const closeBoth = (code, reason) => { try { server.close(code, reason); } catch (e) {} try { upstream && upstream.close(code, reason); } catch (e) {} };
  let upstream = null;
  if (!hasCredentials(env)) {
    server.send(JSON.stringify({ type: "relay_error", msg: "Kalshi credentials not configured on the server" }));
    server.close(1011, "no credentials");
    return new Response(null, { status: 101, webSocket: client });
  }
  try {
    upstream = await openKalshiSocket(env);
  } catch (e) {
    server.send(JSON.stringify({ type: "relay_error", msg: String(e.message || e) }));
    server.close(1011, "upstream failed");
    return new Response(null, { status: 101, webSocket: client });
  }
  server.send(JSON.stringify({ type: "relay_ready", env: (env.KALSHI_ENV || "prod").toLowerCase() }));
  upstream.addEventListener("message", (ev) => { try { server.send(ev.data); } catch (e) { closeBoth(1011, "client gone"); } });
  upstream.addEventListener("close", (ev) => { try { server.close(ev.code || 1000, ev.reason || "upstream closed"); } catch (e) {} });
  upstream.addEventListener("error", () => closeBoth(1011, "upstream error"));
  server.addEventListener("message", (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (!m || !ALLOWED_CMDS.has(m.cmd)) { server.send(JSON.stringify({ type: "relay_error", msg: "command not allowed" })); return; }
    try { upstream.send(JSON.stringify(m)); } catch (e) { closeBoth(1011, "upstream gone"); }
  });
  server.addEventListener("close", () => { try { upstream.close(1000, "client closed"); } catch (e) {} });
  return new Response(null, { status: 101, webSocket: client });
}
