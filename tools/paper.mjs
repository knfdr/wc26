// Headless paper trader: the same engine and rules as live.html, without a browser tab to throttle or freeze.
//   node tools/paper.mjs [minutes] [cfg.json]
// Feeds: ESPN scoreboard (schedule, lines), ESPN core API (fast game state), Kalshi public market data.
// Never places orders. Writes trades and decisions to tools/paper-log.jsonl.
import { createRequire } from "node:module";
import { appendFileSync, readFileSync } from "node:fs";
const CFB = createRequire(import.meta.url)("../js/cfb-engine.js");

const MINUTES = +process.argv[2] || 60;
const CFG = { ...CFB.DEFAULT_CONFIG, ...(process.argv[3] ? JSON.parse(readFileSync(process.argv[3], "utf8")) : {}) };
const LOG = new URL("./paper-log.jsonl", import.meta.url);
const K = "https://api.elections.kalshi.com/trade-api/v2";
const SB = "https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?groups=80&limit=300";
const SUMMARY = "https://site.api.espn.com/apis/site/v2/sports/football/college-football/summary?event=";
const CORE = "https://sports.core.api.espn.com/v2/sports/football/leagues/college-football/events/";
const SERIES = ["KXNCAAFGAME", "KXNCAAFSPREAD", "KXNCAAFTOTAL"];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const J = async (u) => { const r = await fetch(u, { headers: { Accept: "application/json" } }); if (!r.ok) throw new Error(r.status + " " + u); return r.json(); };
const t = () => new Date().toLocaleTimeString();
const log = (o) => appendFileSync(LOG, JSON.stringify({ ts: Date.now(), ...o }) + "\n");
const say = (s) => console.log(`${t()} ${s}`);

const st = { events: [], eventsTs: 0, sbGames: [], gs: {}, pre: {}, core: {}, markets: {}, marketTs: {}, positions: {}, cooldowns: {}, realized: 0, trades: [] };

async function refreshEvents() {
  if (Date.now() - st.eventsTs < 300000 && st.events.length) return;
  st.events = (await J(K + "/events?series_ticker=KXNCAAFGAME&status=open&limit=200")).events || []; st.eventsTs = Date.now();
}
async function refreshScoreboard() {
  const d = await J(SB + "&_=" + Date.now());
  st.sbGames = (d.events || []).map(CFB.parseEspnEvent).filter(g => g && (g.state === "in" || (g.state === "pre" && new Date(g.date) - Date.now() < 3600e3)));
  for (const g of st.sbGames) {
    const gs = st.gs[g.id] = st.gs[g.id] || { sbTs: 0 };
    gs.sbTs = Date.now();
    if (!gs.suffix) {
      let best = null; for (const e of st.events) { const sc = CFB.matchEventScore(e.title, g); if (!best || sc > best.sc) best = { sc, e }; }
      if (best && best.sc >= 0.6) gs.suffix = best.e.event_ticker.split("-").slice(1).join("-");
    }
    if (!st.pre[g.id]) {
      if (g.spreadHome != null && g.total != null) st.pre[g.id] = { spreadHome: g.spreadHome, total: g.total };
      else try { const s = await J(SUMMARY + g.id); const pc = (s.pickcenter || [])[0];
        st.pre[g.id] = pc && pc.spread != null ? { spreadHome: -Number(pc.spread), total: Number(pc.overUnder) } : { spreadHome: null, total: null }; } catch (e) {}
    }
  }
}
async function refreshCore() {
  await Promise.all(st.sbGames.filter(g => g.state === "in").map(async g => {
    const base = CORE + g.id + "/competitions/" + g.id + "/";
    try {
      const [status, situation] = await Promise.all([J(base + "status"), J(base + "situation")]);
      const prev = st.core[g.id] || {}; let play = prev.play, playRef = prev.playRef;
      const ref = situation.lastPlay && situation.lastPlay.$ref;
      if (ref && ref !== playRef) { try { play = await J(ref.replace(/^http:/, "https:")); playRef = ref; } catch (e) {} }
      st.core[g.id] = { status, situation, play, playRef, fetchedTs: Date.now() };
    } catch (e) {}
  }));
}
async function refreshMarkets() {
  const lists = await Promise.all(SERIES.map(s => J(`${K}/markets?series_ticker=${s}&status=open&limit=1000`)));
  const by = {}; for (const m of lists.flatMap(l => l.markets || [])) { const suf = m.event_ticker.split("-").slice(1).join("-"); (by[suf] = by[suf] || []).push(m); }
  const now = Date.now();
  for (const g of st.sbGames) {
    const gs = st.gs[g.id]; if (!gs || !gs.suffix || !by[gs.suffix]) continue;
    st.markets[g.id] = by[gs.suffix].map(m => CFB.parseKalshiMarket(m, g)).filter(Boolean); st.marketTs[g.id] = now;
    const win = st.markets[g.id].find(m => m.kind === "win" && m.side === "home"); const md = win ? CFB.mid(win) : null;
    if (md != null) {
      if (gs.midAtChange != null && Math.abs(md - gs.midAtChange) >= CFG.marketJumpCents && now > (gs.freezeUntil || 0)) { gs.freezeUntil = now + CFG.marketJumpFreezeSecs * 1000; gs.midAtChange = md; }
      if (gs.midAtChange == null) gs.midAtChange = md;
      gs.lastMid = md;
    }
  }
}
function merged() {
  const now = Date.now();
  return st.sbGames.map(g => {
    const gs = st.gs[g.id]; const co = st.core[g.id];
    let out = { ...g, feed: "espn" }, ts = gs.sbTs;
    if (co && now - co.fetchedTs < 15000 && co.status && co.status.type && co.status.type.state !== "pre") {
      const c = CFB.applyEspnCore(g, co); if (CFB.feedProgress(c) >= CFB.feedProgress(out)) { out = c; ts = co.fetchedTs; }
    }
    const sig = [out.home.score, out.away.score, out.period, out.clock, out.possession, out.down, out.yardsToGoal].join("|");
    const scoreSig = out.home.score + "-" + out.away.score;
    if (gs.sig !== sig) { gs.sig = sig; gs.midAtChange = gs.lastMid; }
    if (gs.scoreSig && gs.scoreSig !== scoreSig) { gs.lastScoreChangeTs = now; say(`${g.shortName} score ${gs.scoreSig} -> ${scoreSig} (${out.feed})`); }
    gs.scoreSig = scoreSig; gs.dataTs = ts;
    return out;
  });
}
const label = (g, mk) => mk.kind === "win" ? `${(mk.side === "home" ? g.home : g.away).abbr} to win` : mk.kind === "spread" ? `${(mk.side === "home" ? g.home : g.away).abbr} by ${Math.ceil(mk.line)}+` : `Over ${mk.line}`;

function act(games) {
  const now = Date.now();
  const pnlOpen = Object.entries(st.positions).reduce((s, [tk, p]) => {
    const mk = (st.markets[p.gameId] || []).find(m => m.ticker === tk); const q = mk && CFB.sideQuotes(mk, p.side);
    return s + (q && q.bid != null ? (q.bid - p.avgCost) * p.count / 100 : 0); }, 0);
  const input = { now, cfg: CFG, positions: st.positions, cooldowns: st.cooldowns, dailyPnl: st.realized + pnlOpen, games: games.map(g => {
    const gs = st.gs[g.id] || {};
    return { g, pre: st.pre[g.id], dataTs: gs.dataTs, lastScoreChangeTs: gs.lastScoreChangeTs, freezeUntil: gs.freezeUntil, markets: st.markets[g.id] || [], marketTs: st.marketTs[g.id] || 0, enabled: true };
  }) };
  const res = CFB.decide(input);
  for (const ev of res.evals) { const p = st.positions[ev.ticker]; if (!p) continue; const mk = (st.markets[ev.gameId] || []).find(m => m.ticker === ev.ticker); const b = mk && CFB.sideQuotes(mk, p.side).bid; if (b > (p.peakBid || 0)) p.peakBid = b; }
  for (const a of res.actions.sort((x, y) => (x.type === "sell" ? 0 : 1) - (y.type === "sell" ? 0 : 1))) {
    const g = games.find(x => x.id === a.gameId); const mk = (st.markets[a.gameId] || []).find(m => m.ticker === a.ticker); if (!g || !mk) continue;
    const fee = CFB.feeCents(a.limit, a.count, CFG.feeRate) / 100, L = label(g, mk);
    if (a.type === "buy") {
      if (!a.lead && (st.seen = st.seen || {}, st.seen[a.ticker] = (st.seen[a.ticker] || 0) + 1) < CFG.confirmTicks) continue;
      st.positions[a.ticker] = { side: a.side, count: a.count, avgCost: a.limit, peakBid: a.limit, openedAt: now, gameId: a.gameId, fees: fee, lead: !!a.lead, tpPrice: a.takeProfitPrice, label: L };
      st.realized -= fee;
      say(`BUY  ${a.count}x ${L} ${a.side.toUpperCase()} @ ${a.limit}c — ${a.reason} [${g.shortName} ${g.away.score}-${g.home.score} Q${g.period} ${g.clock}]`);
      log({ type: "buy", game: g.shortName, label: L, ...a, state: { s: `${g.away.score}-${g.home.score}`, q: g.period, clock: g.clock, feed: g.feed } });
    } else {
      const p = st.positions[a.ticker]; if (!p) continue;
      const pnl = (a.limit - p.avgCost) * p.count / 100 - fee - p.fees;
      st.realized += (a.limit - p.avgCost) * p.count / 100 - fee;
      st.trades.push({ label: L, pnl, lead: p.lead, reason: a.reason });
      delete st.positions[a.ticker];
      st.cooldowns[a.ticker] = { until: now + CFG.cooldownSecs * 1000, exits: ((st.cooldowns[a.ticker] || {}).exits || 0) + 1 };
      if (/^stop loss/.test(a.reason)) { const n = (st.cooldowns["stops:" + a.gameId] || 0) + 1; st.cooldowns["stops:" + a.gameId] = n;
        st.cooldowns["game:" + a.gameId] = { until: now + (n >= CFG.maxStopsPerGame ? 12 * 3600e3 : CFG.gameTimeoutSecs * 1000) }; }
      say(`SELL ${p.count}x ${L} @ ${a.limit}c (cost ${p.avgCost}c) ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} — ${a.reason}`);
      log({ type: "sell", game: g.shortName, label: L, ...a, pnl, entry: p.avgCost, lead: p.lead, heldSecs: Math.round((now - p.openedAt) / 1000) });
    }
  }
  if (!st.seenTick || now - st.seenTick > 6000) { st.seenTick = now; const live = new Set(res.actions.filter(a => a.type === "buy").map(a => a.ticker)); for (const k of Object.keys(st.seen || {})) if (!live.has(k)) delete st.seen[k]; }
}
function summary(final) {
  const by = (f) => { const a = st.trades.filter(f); return `${a.length} trades, ${a.filter(x => x.pnl > 0).length}W, $${a.reduce((s, x) => s + x.pnl, 0).toFixed(2)}`; };
  say(`${final ? "FINAL" : "STATUS"} realized $${st.realized.toFixed(2)} | lead: ${by(x => x.lead)} | model: ${by(x => !x.lead)} | open ${Object.keys(st.positions).length}`);
}

say(`paper runner: ${MINUTES} min, lead-only=${!CFG.modelEntries}, entryEdge ${CFG.entryEdge}, leadEntryEdge ${CFG.leadEntryEdge}`);
log({ type: "start", cfg: CFG });
const end = Date.now() + MINUTES * 60000;
let lastSb = 0, lastMk = 0, lastSum = Date.now();
while (Date.now() < end) {
  const t0 = Date.now();
  try {
    await refreshEvents();
    if (Date.now() - lastSb > 5000) { await refreshScoreboard(); lastSb = Date.now(); }
    const jobs = [refreshCore()];
    if (Date.now() - lastMk > 3000) { jobs.push(refreshMarkets().then(() => { lastMk = Date.now(); })); }
    await Promise.all(jobs.map(p => p.catch(e => say("feed error: " + e.message))));
    act(merged());
  } catch (e) { say("error: " + e.message); }
  if (Date.now() - lastSum > 300000) { summary(false); lastSum = Date.now(); }
  await sleep(Math.max(200, 1500 - (Date.now() - t0)));
}
summary(true);
