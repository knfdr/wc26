// NFL pregame model check: simulate today's games and compare every Kalshi strike's mid with the model.
//   node tools/nfl-check.mjs [sims]
import { createRequire } from "node:module";
const CFB = createRequire(import.meta.url)("../js/cfb-engine.js");
const N = +process.argv[2] || 100000;
const K = "https://api.elections.kalshi.com/trade-api/v2";
const J = async (u) => { const r = await fetch(u); if (!r.ok) throw new Error(r.status + " " + u); return r.json(); };

const sb = await J("https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard");
const games = sb.events.map(e => CFB.parseEspnEvent(e, "nfl")).filter(g => g && g.state === "pre" && g.spreadHome != null && g.total != null);
const events = (await J(K + "/events?series_ticker=KXNFLGAME&status=open&limit=200")).events;
const all = (await Promise.all(["KXNFLGAME", "KXNFLSPREAD", "KXNFLTOTAL"].map(s => J(`${K}/markets?series_ticker=${s}&status=open&limit=1000`)))).flatMap(x => x.markets);
let errs = [], sdm = [], sdt = [];
for (const g of games) {
  let best = null; for (const e of events) { const sc = CFB.matchEventScore(e.title, g); if (!best || sc > best.sc) best = { sc, e }; }
  if (!best || best.sc < 0.6) { console.log("no Kalshi match:", g.shortName); continue; }
  const suf = best.e.event_ticker.split("-").slice(1).join("-");
  const mks = all.filter(m => m.event_ticker.endsWith("-" + suf)).map(m => CFB.parseKalshiMarket(m, g)).filter(Boolean);
  const t0 = Date.now();
  const d = CFB.pregameDriveSim(g.spreadHome, g.total, N, "nfl");
  sdm.push(d.sdMargin); sdt.push(d.sdTotal);
  const rows = [];
  for (const mk of mks) {
    const md = CFB.mid(mk); if (md == null || mk.yesAsk - mk.yesBid > 6 || md < 8 || md > 92) continue;
    const p = CFB.modelYesProb(mk, d) * 100;
    rows.push(`${mk.kind === "win" ? (mk.side === "home" ? g.home.abbr : g.away.abbr) + " win" : mk.kind === "spread" ? (mk.side === "home" ? g.home.abbr : g.away.abbr) + " >" + mk.line : "O " + mk.line}: mkt ${md.toFixed(0)} model ${p.toFixed(0)}`);
    errs.push({ kind: mk.kind, e: p - md });
  }
  console.log(`${g.shortName.padEnd(10)} spread ${g.spreadHome} total ${g.total} | sim ${Date.now() - t0}ms  sd margin ${d.sdMargin.toFixed(1)} total ${d.sdTotal.toFixed(1)}  tie ${(d.pTie * 100).toFixed(1)}%  P(margin=±3) ${((d.marginFreq(3) + d.marginFreq(-3)) * 100).toFixed(1)}%  ±7 ${((d.marginFreq(7) + d.marginFreq(-7)) * 100).toFixed(1)}%`);
  console.log("   " + rows.join(" · "));
}
const by = (k) => { const x = errs.filter(e => e.kind === k).map(e => e.e); return x.length ? `${k}: n ${x.length} bias ${(x.reduce((a, b) => a + b, 0) / x.length).toFixed(1)}¢ mean|err| ${(x.reduce((a, b) => a + Math.abs(b), 0) / x.length).toFixed(1)}¢` : `${k}: none`; };
console.log("\nmodel minus market:", ["win", "spread", "total"].map(by).join(" | "));
console.log(`avg sim sd margin ${(sdm.reduce((a, b) => a + b, 0) / sdm.length).toFixed(1)} (NFL actual ~13.2), total ${(sdt.reduce((a, b) => a + b, 0) / sdt.length).toFixed(1)} (NFL actual ~13)`);
