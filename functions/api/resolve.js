// Settles the pick record (gist sharpsim_bets.json). Every pick is made against a Kalshi market, so it settles from
// that market's result through Kalshi's free public API. Older picks without a ticker (World Cup / MLB / WNBA from
// the sportsbook-odds era) were settled at the time; the few left pending can't be settled any more and are ignored
// by the record.
const GIST_ID = "8a76d2b09c709882e4364528a0152ccc";
const GIST_FILENAME = "sharpsim_bets.json";
const KALSHI = "https://api.elections.kalshi.com/trade-api/v2/markets/";

export async function onRequest(context) {
  const { GITHUB_TOKEN } = context.env;
  const gh = { Authorization: `token ${GITHUB_TOKEN}`, Accept: "application/vnd.github.v3+json", "User-Agent": "wc26-proxy" };
  const gistRes = await fetch(`https://api.github.com/gists/${GIST_ID}`, { headers: gh });
  if (!gistRes.ok) return new Response("Gist read failed", { status: 500 });
  const gistData = await gistRes.json();
  const bets = JSON.parse(gistData.files[GIST_FILENAME]?.content || "[]");

  const tickers = [...new Set(bets.filter(b => b.result === "pending" && b.ticker).map(b => b.ticker))].slice(0, 40);
  const result = {};
  await Promise.all(tickers.map(async t => {
    try {
      const r = await fetch(KALSHI + encodeURIComponent(t));
      if (!r.ok) return;
      const m = (await r.json()).market || {};
      if (m.result === "yes" || m.result === "no") result[t] = m.result;
    } catch (e) {}
  }));

  let changed = false;
  const resolved = bets.map(b => {
    if (b.result !== "pending" || !b.ticker || !result[b.ticker]) return b;
    changed = true;
    return { ...b, result: result[b.ticker] === (b.side || "yes") ? "win" : "loss", resolvedAt: new Date().toISOString() };
  });
  if (changed) {
    await fetch(`https://api.github.com/gists/${GIST_ID}`, { method: "PATCH", headers: { ...gh, "Content-Type": "application/json" },
      body: JSON.stringify({ files: { [GIST_FILENAME]: { content: JSON.stringify(resolved, null, 2) } } }) });
  }
  return new Response(JSON.stringify(resolved), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
