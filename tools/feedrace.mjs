// Feed race: for every score change in live CFB games, when did each source show it, and when did Kalshi's price move?
//   node tools/feedrace.mjs [minutes]
// Sources: ESPN core (plus the play's wallclock), ESPN scoreboard, Kalshi live_data (Stats Perform, plus its occurence_ts),
// and Kalshi market mids (every market on the game, polled ~1s). Read-only; writes tools/feedrace.jsonl.
import { createRequire } from "node:module";
import { appendFileSync } from "node:fs";
const CFB = createRequire(import.meta.url)("../js/cfb-engine.js");

const MINUTES = +process.argv[2] || 20;
const OUT = new URL("./feedrace.jsonl", import.meta.url);
const K = "https://api.elections.kalshi.com/trade-api/v2";
const SB = "https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?groups=80&limit=300";
const CORE = "https://sports.core.api.espn.com/v2/sports/football/leagues/college-football/events/";
const SERIES = ["KXNCAAFGAME", "KXNCAAFSPREAD", "KXNCAAFTOTAL"];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const J = async (u) => { const r = await fetch(u, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(6000) }); if (!r.ok) throw new Error(r.status + " " + u.split("?")[0]); return r.json(); };
const hms = (ts) => ts ? new Date(ts).toLocaleTimeString() : "—";

const G = {};          // espn id -> { g, suffix, milestone, flip, src: {core, sb, kal}, mids: [[ts, {ticker: mid}]], races: {} }
let events = [];

function race(id, score) { const r = G[id].races; return r[score] = r[score] || { score, seen: {} }; }
function saw(id, src, score, extra) {
  const x = G[id]; if (!x) return;
  if (x.src[src] === score) return;
  const first = x.src[src] === undefined; x.src[src] = score;
  if (first) return;                       // baseline, not a change
  const r = race(id, score);
  if (!r.seen[src]) { r.seen[src] = Date.now(); Object.assign(r, extra || {}); if (!r.firstTs) r.firstTs = Date.now(); }
}

async function scoreboard() {
  const d = await J(SB + "&_=" + Date.now());
  if (!events.length) events = (await J(K + "/events?series_ticker=KXNCAAFGAME&status=open&limit=200")).events || [];
  for (const g of (d.events || []).map(CFB.parseEspnEvent).filter(g => g && g.state === "in")) {
    const x = G[g.id] = G[g.id] || { g, src: {}, mids: [], races: {} };
    x.g = g;
    if (!x.suffix) { let best = null; for (const e of events) { const sc = CFB.matchEventScore(e.title, g); if (!best || sc > best.sc) best = { sc, e }; } if (best && best.sc >= 0.6) x.suffix = best.e.event_ticker.split("-").slice(1).join("-"); }
    if (x.suffix && x.milestone === undefined) {
      try { const m = ((await J(K + "/milestones?limit=5&related_event_ticker=KXNCAAFGAME-" + x.suffix)).milestones || []).find(m => m.type === "football_game");
        x.milestone = m || null; if (m) { const parts = String(m.title || "").split(/\s+at\s+/i); x.flip = parts.length === 2 && CFB.nameScore(parts[1], g.away) > CFB.nameScore(parts[1], g.home); } } catch (e) { x.milestone = null; }
    }
    saw(g.id, "sb", g.away.score + "-" + g.home.score);
  }
}
async function core() {
  await Promise.all(Object.entries(G).map(async ([id, x]) => {
    try {
      const sit = await J(CORE + id + "/competitions/" + id + "/situation?_=" + Date.now());
      const ref = sit.lastPlay && sit.lastPlay.$ref; if (!ref || ref === x.playRef) return;
      const pl = await J(ref.replace(/^http:/, "https:")); x.playRef = ref;
      if (pl.awayScore == null || pl.homeScore == null) return;
      // core can't move a score below the scoreboard's (its PAT plays sometimes carry a stale score)
      const a = Math.max(+pl.awayScore, x.g.away.score), h = Math.max(+pl.homeScore, x.g.home.score);
      saw(id, "core", a + "-" + h, { wallclock: pl.wallclock ? Date.parse(pl.wallclock) : null, text: (pl.text || "").slice(0, 70) });
    } catch (e) {}
  }));
}
async function kalshiLive() {
  const ms = Object.entries(G).filter(([, x]) => x.milestone);
  if (!ms.length) return;
  const d = await J(K + "/live_data/batch?" + ms.map(([, x]) => "milestone_ids=" + x.milestone.id).join("&"));
  for (const ld of d.live_datas || []) {
    const e = ms.find(([, x]) => x.milestone.id === ld.milestone_id); if (!e || !ld.details) continue;
    const [id, x] = e, dd = ld.details;
    const a = x.flip ? dd.home_points : dd.away_points, h = x.flip ? dd.away_points : dd.home_points;
    if (a == null || h == null) continue;
    // Kalshi's home/away order doesn't always match ESPN's: settle it once against the scoreboard
    if (!x.flipChecked && (+a !== +h)) {
      const sa = x.g.away.score, sh = x.g.home.score;
      if (+a === sh && +h === sa && !(+a === sa && +h === sh)) { x.flip = !x.flip; x.flipChecked = true; continue; }
      if (+a === sa && +h === sh) x.flipChecked = true;
    }
    if (!x.flipChecked) continue;
    saw(id, "kal", a + "-" + h, { kalOccur: dd.last_play && dd.last_play.occurence_ts ? dd.last_play.occurence_ts * 1000 : null, kalText: dd.last_play ? (dd.last_play.description || "").slice(0, 70) : "" });
  }
}
async function markets() {
  const lists = await Promise.all(SERIES.map(s => J(`${K}/markets?series_ticker=${s}&status=open&limit=1000`)));
  const by = {}; for (const m of lists.flatMap(l => l.markets || [])) { const suf = m.event_ticker.split("-").slice(1).join("-"); (by[suf] = by[suf] || []).push(m); }
  const now = Date.now();
  for (const x of Object.values(G)) {
    if (!x.suffix || !by[x.suffix]) continue;
    const mids = {}; for (const m of by[x.suffix]) { const pm = CFB.parseKalshiMarket(m, x.g); const md = pm && CFB.mid(pm); if (pm && pm.kind === "win" && pm.side === "home") x.mlTicker = m.ticker; if (md != null && (md >= 5 && md <= 95 || m.ticker === x.mlTicker)) mids[m.ticker] = md; }
    x.mids.push([now, mids]); while (x.mids.length && now - x.mids[0][0] > 300000) x.mids.shift();
  }
}
// When did the price react? The moment the summed absolute mid change over the previous 4s peaks, within -60s..+120s of the score.
function marketMove(x, t0) {
  const pts = x.mids.filter(([ts]) => ts >= t0 - 60000 && ts <= t0 + 120000);
  let best = null;
  for (let i = 0; i < pts.length; i++) {
    const [ts, m] = pts[i]; const j = pts.findIndex(([tj]) => tj >= ts - 4000); if (j < 0 || j >= i) continue;
    const prev = pts[j][1]; let sum = 0, n = 0;
    for (const tk in m) if (prev[tk] != null) { sum += Math.abs(m[tk] - prev[tk]); n++; }
    if (n && (!best || sum > best.sum)) best = { ts, sum, n };
  }
  return best && best.sum >= 6 ? best : null;
}
function report(id, r) {
  const x = G[id]; const ref = r.wallclock || r.kalOccur || r.firstTs;
  const rel = (ts) => ts ? ((ts - ref) / 1000).toFixed(0).padStart(4) + "s" : "   — ";
  const mv = marketMove(x, r.firstTs);
  const row = { game: x.g.shortName, score: r.score, ref: r.wallclock ? "espn wallclock" : r.kalOccur ? "kalshi occur" : "first seen",
    wallclock: r.wallclock, kalOccur: r.kalOccur, core: r.seen.core, sb: r.seen.sb, kal: r.seen.kal, market: mv && mv.ts, marketSum: mv && mv.sum, text: r.text || r.kalText };
  // moneyline (home-win) mid every ~1s from -30s to +90s around the play, plus the first second it moved 3c+ from its -30s value
  const ml = x.mlTicker, tl = ml ? x.mids.filter(([ts, m]) => ts >= ref - 30000 && ts <= ref + 90000 && m[ml] != null).map(([ts, m]) => [Math.round((ts - ref) / 1000), m[ml]]) : [];
  const base = tl.length ? tl[0][1] : null, firstMove = tl.find(([, v]) => base != null && Math.abs(v - base) >= 3);
  row.mlTimeline = tl; row.mlFirstMove = firstMove ? firstMove[0] : null;
  appendFileSync(OUT, JSON.stringify(row) + "\n");
  console.log(`${hms(ref)} ${x.g.shortName.padEnd(12)} ${r.score.padEnd(7)} | kalshi feed ${rel(r.seen.kal)} | espn core ${rel(r.seen.core)} | scoreboard ${rel(r.seen.sb)} | ML MOVED 3c+ ${row.mlFirstMove != null ? String(row.mlFirstMove).padStart(4) + "s" : "   — "} | BIGGEST MOVE ${mv ? rel(mv.ts) + ` (${mv.sum.toFixed(0)}¢ over ${mv.n} mkts)` : "   — "} | kalshi occur ${rel(r.kalOccur)}  ${(r.text || r.kalText || "").slice(0, 50)}`);
}

const end = Date.now() + MINUTES * 60000;
console.log(`feed race for ${MINUTES} min — times are relative to the play's real time (ESPN wallclock when known)`);
let pass = 0;
await scoreboard();
while (Date.now() < end) {
  const t0 = Date.now(); pass++;
  try {
    await Promise.all([markets().catch(e => console.log("markets: " + e.message)), kalshiLive().catch(e => console.log("kalshi live: " + e.message)),
      pass % 2 === 0 ? core() : null, pass % 5 === 0 ? scoreboard().catch(() => {}) : null]);
  } catch (e) {}
  // report a race 120s after it was first seen, once every source has had its chance
  for (const [id, x] of Object.entries(G)) for (const r of Object.values(x.races)) if (!r.done && Date.now() - r.firstTs > 120000) { r.done = true; report(id, r); }
  await sleep(Math.max(200, 1000 - (Date.now() - t0)));
}
for (const [id, x] of Object.entries(G)) for (const r of Object.values(x.races)) if (!r.done && Date.now() - r.firstTs > 30000) report(id, r);
