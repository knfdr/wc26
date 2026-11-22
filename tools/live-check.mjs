// Live model check: every 30s, price every in-progress game with the live engine and compare with Kalshi's mids.
//   node tools/live-check.mjs [cfb|nfl] [minutes]
// "raw" = drive sim calibrated to the moneyline and one total strike; "final" = after the ladder correction (what the bot uses).
import { createRequire } from "node:module";
const CFB = createRequire(import.meta.url)("../js/cfb-engine.js");
const SPORT = process.argv[2] === "cfb" ? "cfb" : "nfl", MINUTES = +process.argv[3] || 60;
const L = SPORT === "nfl" ? { sb: "nfl/scoreboard?limit=40", series: ["KXNFLGAME", "KXNFLSPREAD", "KXNFLTOTAL"] }
                          : { sb: "college-football/scoreboard?groups=80&limit=300", series: ["KXNCAAFGAME", "KXNCAAFSPREAD", "KXNCAAFTOTAL"] };
const K = "https://api.elections.kalshi.com/trade-api/v2";
const J = async (u) => { const r = await fetch(u, { signal: AbortSignal.timeout(8000) }); if (!r.ok) throw new Error(r.status + " " + u); return r.json(); };
const pre = {}, suffix = {};
let events = [];
const totals = { raw: [], final: [] };
const end = Date.now() + MINUTES * 60000;
console.log(`live model check (${SPORT}) for ${MINUTES} min`);
while (Date.now() < end) {
  try {
    if (!events.length) events = (await J(K + `/events?series_ticker=${L.series[0]}&status=open&limit=200`)).events;
    const sb = await J("https://site.api.espn.com/apis/site/v2/sports/football/" + L.sb + "&_=" + Date.now());
    const games = sb.events.map(e => CFB.parseEspnEvent(e, SPORT)).filter(g => g && g.state === "in");
    for (const g of sb.events.map(e => CFB.parseEspnEvent(e, SPORT)).filter(Boolean)) if (!pre[g.id] && g.spreadHome != null && g.total != null) pre[g.id] = { spreadHome: g.spreadHome, total: g.total };
    const all = (await Promise.all(L.series.map(s => J(`${K}/markets?series_ticker=${s}&status=open&limit=1000`)))).flatMap(x => x.markets);
    const lines = [];
    for (const g of games) {
      if (!suffix[g.id]) { let best = null; for (const e of events) { const sc = CFB.matchEventScore(e.title, g); if (!best || sc > best.sc) best = { sc, e }; } if (best && best.sc >= 0.6) suffix[g.id] = best.e.event_ticker.split("-").slice(1).join("-"); }
      if (!suffix[g.id]) continue;
      const mks = all.filter(m => m.event_ticker.endsWith("-" + suffix[g.id])).map(m => CFB.parseKalshiMarket(m, g)).filter(Boolean);
      const t0 = Date.now();
      const live = CFB.liveDistribution(g, pre[g.id], mks, { ...CFB.DEFAULT_CONFIG, alpha: 0 });
      const ms = Date.now() - t0;
      const err = { raw: [], final: [] };
      for (const mk of mks) {
        const md = CFB.mid(mk); if (md == null || mk.yesAsk - mk.yesBid > 6 || md < 8 || md > 92) continue;
        err.raw.push(CFB.modelYesProb(mk, live.mixed) * 100 - md);
        err.final.push(CFB.modelYesProb(mk, live.dist) * 100 - md);
      }
      if (!err.raw.length) continue;
      totals.raw.push(...err.raw); totals.final.push(...err.final);
      const mae = (x) => (x.reduce((a, b) => a + Math.abs(b), 0) / x.length).toFixed(1);
      lines.push(`${g.shortName.padEnd(10)} ${g.away.score}-${g.home.score} Q${g.period} ${g.clock.padStart(5)} | ${err.raw.length} strikes | raw ${mae(err.raw)}¢  final ${mae(err.final)}¢ | ${ms}ms`);
    }
    if (lines.length) {
      const mae = (x) => x.length ? (x.reduce((a, b) => a + Math.abs(b), 0) / x.length).toFixed(2) : "—";
      console.log(new Date().toLocaleTimeString() + `  running mean |model - market|: raw ${mae(totals.raw)}¢  final ${mae(totals.final)}¢  (${totals.final.length} quotes)`);
      for (const l of lines) console.log("   " + l);
    } else console.log(new Date().toLocaleTimeString() + "  no games in progress");
  } catch (e) { console.log("error: " + e.message); }
  await new Promise(r => setTimeout(r, 30000));
}
