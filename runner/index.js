// Sharp Sim server-side runner: a Cloudflare Worker + Durable Object that runs the CFB live engine on a timer,
// independent of any browser tab. Same engine (js/cfb-engine.js) and feeds as live.html / tools/paper.mjs.
//
// Control API (all require header X-Runner-Token = env.RUNNER_TOKEN; the site reaches it via /api/runner/*):
//   GET  /status                 state, P&L, positions, recent log
//   GET  /account                Kalshi connection check + cash balance (read-only)
//   POST /start   {mode, cfg?, enabled?}   mode "paper" | "live" ("live" also needs confirm:"LIVE")
//   POST /stop                   stop entries and the loop (positions are kept)
//   POST /kill                   sell every bot position, then stop
//   POST /config  {cfg?, enabled?}
//   POST /reset-paper            clear the paper ledger
//   POST /manage  {ticker, rules|null}   hand one of your own Kalshi positions to the runner: rules {tpPrice, slPrice, trailArm, trailGive}
//   POST /settings {entries}     entries=false (default): exits only, the runner opens nothing itself
// Paper mode never sells your real positions: it logs what it WOULD have sold (shadow trades) so you can check the rules.
// Live orders go through lib/kalshi.js checkOrder, so KALSHI_TRADING_ENABLED=1 and the order cap still apply.
import CFB from "../js/cfb-engine.js";
import { kalshiFetch, hasCredentials, checkOrder } from "../lib/kalshi.js";

const K = "https://api.elections.kalshi.com/trade-api/v2";
// College football and NFL run side by side; each game carries its sport (g.sport) into the engine.
const ESPN = "https://site.api.espn.com/apis/site/v2/sports/football/", ESPN_CORE = "https://sports.core.api.espn.com/v2/sports/football/leagues/";
const LEAGUES = {
  cfb: { sb: ESPN + "college-football/scoreboard?groups=80&limit=300", summary: ESPN + "college-football/summary?event=", core: ESPN_CORE + "college-football/events/",
         series: ["KXNCAAFGAME", "KXNCAAFSPREAD", "KXNCAAFTOTAL"], game: "KXNCAAFGAME" },
  nfl: { sb: ESPN + "nfl/scoreboard?limit=40", summary: ESPN + "nfl/summary?event=", core: ESPN_CORE + "nfl/events/",
         series: ["KXNFLGAME", "KXNFLSPREAD", "KXNFLTOTAL"], game: "KXNFLGAME" },
};
const TICKER_RE = /^KX(NCAAF|NFL)(GAME|SPREAD|TOTAL)-/;
const sportOfTicker = (t) => /^KXNFL/.test(t) ? "nfl" : "cfb";
const MAX_CORE_GAMES = 10;   // the free plan allows 50 outside fetches per tick
const TICK_MS = 2000, IDLE_MS = 60000;
// Feed fetches time out after 6s so a hung request can't stall a tick.

const J = async (u) => { const r = await fetch(u, { headers: { Accept: "application/json", "User-Agent": "sharp-sim-runner" }, signal: AbortSignal.timeout(6000) }); if (!r.ok) throw new Error(r.status + " " + u.split("?")[0]); return r.json(); };
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

// Kalshi v2 quotes every order on the YES leg (same translation as live.html).
function toOrder(type, side, cents, count) {
  const yesPrice = side === "yes" ? cents : 100 - cents;
  const book = (type === "buy") === (side === "yes") ? "bid" : "ask";
  return { side: book, price: (Math.min(99, Math.max(1, yesPrice)) / 100).toFixed(2), count: String(count) };
}
const label = (g, mk) => !g || !mk ? mk ? mk.ticker : "?" : mk.kind === "win" ? `${(mk.side === "home" ? g.home : g.away).abbr} to win`
  : mk.kind === "spread" ? `${(mk.side === "home" ? g.home : g.away).abbr} by ${Math.ceil(mk.line)}+` : `Over ${mk.line}`;

export default {
  async fetch(request, env) {
    if (!env.RUNNER_TOKEN || request.headers.get("X-Runner-Token") !== env.RUNNER_TOKEN) return json({ error: "unauthorized" }, 401);
    const id = env.RUNNER.idFromName("cfb");
    return env.RUNNER.get(id).fetch(request);
  },
};

export class Runner {
  constructor(state, env) {
    this.state = state; this.env = env;
    this.mem = { events: [], eventsTs: 0, sbGames: [], sbTs: 0, gs: {}, core: {}, markets: {}, marketTs: {}, mkTs: 0, seen: {}, posTs: 0 };
    this.ready = state.blockConcurrencyWhile(async () => {
      this.s = (await state.storage.get("s")) || {
        running: false, mode: "paper", cfg: {}, enabled: { all: true }, killed: false,
        paper: { positions: {}, realized: 0, trades: [] }, live: { meta: {}, realized: 0, trades: [] },
        cooldowns: {}, pre: {}, log: [], startedAt: null, lastTick: null, tickMs: 0, errors: 0,
      };
      this.s.managed = this.s.managed || {};
      this.s.shadow = this.s.shadow || { trades: [], done: {} };
      if (this.s.entries === undefined) this.s.entries = false;
    });
  }
  cfg() { return { ...CFB.DEFAULT_CONFIG, ...(this.s.cfg || {}) }; }
  log(kind, msg) { this.s.log.unshift({ ts: Date.now(), kind, msg }); if (this.s.log.length > 400) this.s.log.length = 400; }
  async save() { await this.state.storage.put("s", this.s); }

  async fetch(request) {
    await this.ready;
    const url = new URL(request.url), path = url.pathname.replace(/^\/+/, "").replace(/^api\/runner\/?/, "");
    const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};
    if (path === "status" || path === "") {
      // while stopped nothing ticks, so read your positions (and their prices) here, at most every 15s, so you can pick them before starting
      if (!this.s.running && hasCredentials(this.env) && Date.now() - (this.mem.posTs || 0) > 15000) {
        try { await this.refreshEvents(); await this.refreshScoreboard(); await Promise.all([this.refreshMarkets(), this.refreshLivePositions()]); await this.save(); }
        catch (e) { this.mem.posTs = Date.now(); }
      }
      return json(this.status(url.searchParams.get("log") !== "0"));
    }
    if (path === "account") {   // read-only: proves the runner's Kalshi key works, for the page's readiness checklist
      if (!hasCredentials(this.env)) return json({ connected: false, error: "no Kalshi key on the runner" });
      try {
        const r = await kalshiFetch(this.env, "GET", "/portfolio/balance");
        if (r.status !== 200) return json({ connected: false, error: "Kalshi said " + r.status });
        const b = JSON.parse(r.text);
        const d = (dollars, cents) => dollars != null ? parseFloat(dollars) : (cents || 0) / 100;
        return json({ connected: true, cash: d(b.balance_dollars, b.balance), portfolio: d(b.portfolio_value_dollars, b.portfolio_value) });
      } catch (e) { return json({ connected: false, error: e.message }); }
    }
    if (request.method !== "POST") return json({ error: "POST required" }, 405);
    if (path === "start") {
      const mode = body.mode === "live" ? "live" : "paper";
      if (mode === "live") {
        if (body.confirm !== "LIVE") return json({ error: 'live mode needs confirm:"LIVE"' }, 400);
        if (!hasCredentials(this.env)) return json({ error: "Kalshi credentials are not set on the runner" }, 400);
        if (this.env.KALSHI_TRADING_ENABLED !== "1") return json({ error: "KALSHI_TRADING_ENABLED is not 1 on the runner" }, 400);
      }
      if (body.cfg) this.s.cfg = sanitizeCfg(body.cfg);
      if (body.enabled) this.s.enabled = body.enabled;
      if (body.entries !== undefined) this.s.entries = !!body.entries;
      Object.assign(this.s, { running: true, mode, killed: false, startedAt: Date.now() });
      this.mem.seen = {};
      this.log("info", `Server runner started (${mode.toUpperCase()})`);
      await this.save(); await this.state.storage.setAlarm(Date.now() + 100);
      return json(this.status(false));
    }
    if (path === "stop") { this.s.running = false; this.log("info", "Server runner stopped"); await this.save(); return json(this.status(false)); }
    if (path === "kill") { this.s.killed = true; this.s.running = true; this.log("info", "Kill switch: cashing out every bot position"); await this.save(); await this.state.storage.setAlarm(Date.now() + 100); return json(this.status(false)); }
    if (path === "config") { if (body.cfg) this.s.cfg = sanitizeCfg(body.cfg); if (body.enabled) this.s.enabled = body.enabled; await this.save(); return json(this.status(false)); }
    if (path === "manage") {
      const t = String(body.ticker || "");
      if (!/^KX(NCAAF|NFL)(GAME|SPREAD|TOTAL)-[A-Z0-9-]+$/.test(t)) return json({ error: "not a college football or NFL game, spread or total market" }, 400);
      if (!body.rules) { this.s.managed[t] = undefined; this.s.shadow.done[t] = undefined; this.prune(); this.log("info", `Stopped managing ${t}`); }
      else {
        const c = (v) => v == null || v === "" || !isFinite(+v) || +v <= 0 ? null : Math.min(99, Math.max(1, Math.round(+v)));
        const r = { tpPrice: c(body.rules.tpPrice), slPrice: c(body.rules.slPrice), trailArm: c(body.rules.trailArm) || 0, trailGive: c(body.rules.trailGive) };
        if (!r.tpPrice && !r.slPrice && !r.trailGive) return json({ error: "set at least one rule (target, stop or trailing)" }, 400);
        if (r.tpPrice && r.slPrice && r.slPrice >= r.tpPrice) return json({ error: "the stop must be below the target" }, 400);
        this.s.managed[t] = { ...r, peakBid: (this.s.managed[t] || {}).peakBid || 0, since: Date.now() };
        this.s.shadow.done[t] = undefined; this.prune();
        this.log("info", `Managing ${t}: ${[r.tpPrice && "sell at " + r.tpPrice + "¢", r.slPrice && "stop at " + r.slPrice + "¢", r.trailGive && `trail ${r.trailGive}¢ after +${r.trailArm}¢`].filter(Boolean).join(", ")}`);
      }
      await this.save(); return json(this.status(false));
    }
    if (path === "settings") { if (body.entries !== undefined) { this.s.entries = !!body.entries; this.log("info", this.s.entries ? "New trades: ON (experimental)" : "New trades: OFF (exits only)"); } await this.save(); return json(this.status(false)); }
    if (path === "reset-paper") { this.s.paper = { positions: {}, realized: 0, trades: [] }; this.log("info", "Paper ledger reset"); await this.save(); return json(this.status(false)); }
    return json({ error: "unknown route " + path }, 404);
  }

  prune() {   // drop cleared entries from the managed / shadow maps
    for (const o of [this.s.managed, this.s.shadow.done]) for (const k of Object.keys(o)) if (o[k] === undefined) Reflect.deleteProperty(o, k);
  }
  status(withLog) {
    const s = this.s, book = s.mode === "live" ? s.live : s.paper;
    let open = 0; const positions = [];
    for (const [tk, p] of Object.entries(s.mode === "live" ? (this.mem.livePositions || {}) : s.paper.positions)) {
      const mk = (this.mem.markets[p.gameId] || []).find(m => m.ticker === tk); const q = mk && CFB.sideQuotes(mk, p.side);
      const bid = q && q.bid != null ? q.bid : null; if (bid != null) open += (bid - p.avgCost) * p.count / 100;
      positions.push({ ticker: tk, label: p.label, side: p.side, count: p.count, avgCost: p.avgCost, bid, lead: !!p.lead, openedAt: p.openedAt, unmanaged: !!p.unmanaged });
    }
    const tr = book.trades || [];
    const myPositions = Object.entries(this.mem.myPositions || {}).map(([tk, p]) => {
      const g = this.mem.sbGames.find(x => x.id === p.gameId), mk = (this.mem.markets[p.gameId] || []).find(m => m.ticker === tk);
      const q = mk && CFB.sideQuotes(mk, p.side);
      return { ticker: tk, label: g && mk ? label(g, mk) : tk, game: g ? `${g.away.abbr} ${g.away.score} @ ${g.home.abbr} ${g.home.score} · ${g.state === "in" ? "Q" + g.period + " " + g.clock : g.state}` : "game not on the board yet",
        live: !!(g && g.state === "in"), side: p.side, count: p.count, avgCost: p.avgCost, bid: q && q.bid != null ? q.bid : null,
        botOwned: !!p.botOwned, rules: this.s.managed[tk] || null, shadowDone: !!this.s.shadow.done[tk] };
    });
    return { entries: !!s.entries, myPositions, myPositionsTs: this.mem.posTs || null, shadowTrades: (s.shadow.trades || []).slice(0, 30), managedCount: Object.keys(s.managed).length, running: s.running, mode: s.mode, killed: s.killed, startedAt: s.startedAt, lastTick: s.lastTick, tickMs: s.tickMs, errors: s.errors,
      credentials: hasCredentials(this.env), tradingEnabled: this.env.KALSHI_TRADING_ENABLED === "1",
      realized: book.realized || 0, open, positions, trades: tr.slice(0, 50),
      record: { n: tr.length, wins: tr.filter(t => t.pnl > 0).length, lead: tr.filter(t => t.lead).length },
      games: this.mem.sbGames.filter(g => g.state === "in").length, cfg: s.cfg, enabled: s.enabled, log: withLog ? s.log.slice(0, 150) : undefined };
  }

  async alarm() {
    await this.ready;
    if (!this.s.running) return;
    const t0 = Date.now();
    try { await this.tick(); this.s.errors = 0; }
    catch (e) { this.s.errors = (this.s.errors || 0) + 1; this.log("error", "tick: " + e.message); }
    this.s.lastTick = Date.now(); this.s.tickMs = Date.now() - t0;
    await this.save();
    if (this.s.running) {
      // Tick fast only when there's work: each alarm is a billed request (free plan: 100k/day for the whole account).
      const soon = (g) => g.state === "in" || (g.state === "pre" && new Date(g.date) - Date.now() < 900e3);
      const en = this.s.enabled || {};
      const anyLive = this.s.entries && this.mem.sbGames.some(g => soon(g) && (en.all || en[g.id]));
      const mine = this.mem.myPositions || {};
      const managedLive = Object.keys(this.s.managed).some(t => { const p = mine[t]; const g = p && this.mem.sbGames.find(x => x.id === p.gameId); return g && soon(g) && !(this.s.mode !== "live" && this.s.shadow.done[t]); });
      const hasPos = managedLive || Object.keys(this.s.mode === "live" ? this.s.live.meta : this.s.paper.positions).length > 0;
      await this.state.storage.setAlarm(Date.now() + (anyLive || hasPos || this.s.killed ? Math.max(200, TICK_MS - this.s.tickMs) : IDLE_MS));
    }
  }

  // ── feeds ────────────────────────────────────────────────────────────────
  async refreshEvents() {
    const m = this.mem; if (Date.now() - m.eventsTs < 300000 && m.events.length) return;
    const lists = await Promise.all(Object.entries(LEAGUES).map(([sport, L]) => J(K + `/events?series_ticker=${L.game}&status=open&limit=200`).then(d => (d.events || []).map(e => ({ ...e, sport })))));
    m.events = lists.flat(); m.eventsTs = Date.now();
  }
  async refreshScoreboard() {
    const m = this.mem; if (Date.now() - m.sbTs < 5000) return;
    const boards = await Promise.all(Object.entries(LEAGUES).map(([sport, L]) => J(L.sb + "&_=" + Date.now()).then(d => (d.events || []).map(e => CFB.parseEspnEvent(e, sport))).catch(() => null)));
    if (boards.every(b => b === null)) throw new Error("ESPN scoreboards unavailable");
    const keep = (g) => g && (g.state === "in" || (g.state === "pre" && new Date(g.date) - Date.now() < 3600e3) || (g.state === "post" && Date.now() - new Date(g.date) < 6 * 3600e3));
    // a league whose scoreboard failed this time keeps its last games
    m.sbGames = Object.keys(LEAGUES).flatMap((sport, i) => boards[i] ? boards[i].filter(keep) : m.sbGames.filter(g => g.sport === sport));
    m.sbTs = Date.now();
    for (const g of m.sbGames) {
      const gs = m.gs[g.id] = m.gs[g.id] || {}; gs.sbTs = m.sbTs;
      if (!gs.suffix) {
        let best = null; for (const e of m.events) { if (e.sport !== g.sport) continue; const sc = CFB.matchEventScore(e.title, g); if (!best || sc > best.sc) best = { sc, e }; }
        if (best && best.sc >= 0.6) gs.suffix = best.e.event_ticker.split("-").slice(1).join("-");
      }
      gs.sport = g.sport;
      if (!this.s.pre[g.id] && g.state !== "post") {
        if (g.spreadHome != null && g.total != null) this.s.pre[g.id] = { spreadHome: g.spreadHome, total: g.total };
        else try { const s = await J(LEAGUES[g.sport].summary + g.id); const pc = (s.pickcenter || [])[0];
          this.s.pre[g.id] = pc && pc.spread != null ? { spreadHome: -Number(pc.spread), total: Number(pc.overUnder) } : { spreadHome: null, total: null }; } catch (e) {}
      }
    }
  }
  async refreshCore() {
    const m = this.mem;
    // ESPN's play-by-play feed showed no edge over the market, so it's only fetched for games that matter: ones with a
    // position (bot or managed) or, when new trades are on, games picked for them
    const held = new Set(Object.values({ ...(m.myPositions || {}), ...this.s.paper.positions }).map(p => p.gameId));
    const en = this.s.enabled || {};
    const want = m.sbGames.filter(g => g.state === "in" && (held.has(g.id) || (this.s.entries && (en.all || en[g.id])))).slice(0, MAX_CORE_GAMES);
    await Promise.all(want.map(async g => {
      const base = LEAGUES[g.sport].core + g.id + "/competitions/" + g.id + "/";
      try {
        const [status, situation] = await Promise.all([J(base + "status"), J(base + "situation")]);
        const prev = m.core[g.id] || {}; let play = prev.play, playRef = prev.playRef;
        const ref = situation.lastPlay && situation.lastPlay.$ref;
        if (ref && ref !== playRef) { try { play = await J(ref.replace(/^http:/, "https:")); playRef = ref; } catch (e) {} }
        m.core[g.id] = { status, situation, play, playRef, fetchedTs: Date.now() };
      } catch (e) {}
    }));
  }
  async refreshMarkets() {
    const m = this.mem; if (Date.now() - m.mkTs < 2500) return;
    // only the leagues that have games on now (each series call is an outside fetch)
    const sports = [...new Set(m.sbGames.map(g => g.sport))];
    const lists = await Promise.all(sports.flatMap(sp => LEAGUES[sp].series).map(s => J(`${K}/markets?series_ticker=${s}&status=open&limit=1000`)));
    const by = {}; for (const x of lists.flatMap(l => l.markets || [])) { const suf = x.event_ticker.split("-").slice(1).join("-"); (by[suf] = by[suf] || []).push(x); }
    const now = Date.now(), cfg = this.cfg(); m.mkTs = now;
    for (const g of m.sbGames) {
      const gs = m.gs[g.id]; if (!gs || !gs.suffix || !by[gs.suffix]) continue;
      m.markets[g.id] = by[gs.suffix].map(x => CFB.parseKalshiMarket(x, g)).filter(Boolean); m.marketTs[g.id] = now;
      const win = m.markets[g.id].find(x => x.kind === "win" && x.side === "home"); const md = win ? CFB.mid(win) : null;
      if (md != null) {
        if (gs.midAtChange != null && Math.abs(md - gs.midAtChange) >= cfg.marketJumpCents && now > (gs.freezeUntil || 0)) { gs.freezeUntil = now + cfg.marketJumpFreezeSecs * 1000; gs.midAtChange = md; }
        if (gs.midAtChange == null) gs.midAtChange = md;
        gs.lastMid = md;
      }
    }
  }
  async refreshLivePositions() {
    const m = this.mem; if (Date.now() - m.posTs < 8000) return;
    const r = await kalshiFetch(this.env, "GET", "/portfolio/positions?limit=200&count_filter=position");
    if (r.status !== 200) throw new Error("positions HTTP " + r.status);
    const d = JSON.parse(r.text), out = {}, meta = this.s.live.meta, cfg = this.cfg();
    for (const p of d.market_positions || []) {
      const t = p.ticker; if (!TICKER_RE.test(t)) continue;
      const pos = parseFloat(p.position_fp != null ? p.position_fp : p.position || 0); if (!pos) continue;
      const count = Math.abs(pos), mt = meta[t] || {};
      const exposure = parseFloat(p.market_exposure_dollars != null ? p.market_exposure_dollars : (p.market_exposure || 0) / 100);
      const gameId = mt.gameId || this.gameIdForTicker(t);
      out[t] = { ...mt, side: pos > 0 ? "yes" : "no", count, avgCost: mt.avgCost || Math.round(exposure / count * 100), gameId,
                 botOwned: !!mt.botOwned, unmanaged: !mt.botOwned && !this.s.managed[t], peakBid: mt.peakBid || 0, openedAt: mt.openedAt || Date.now() };
    }
    for (const t of Object.keys(meta)) if (!out[t]) delete meta[t];   // settled or sold elsewhere
    for (const t of Object.keys(this.s.managed)) if (!out[t]) { this.s.managed[t] = undefined; this.s.shadow.done[t] = undefined; this.log("info", `${t} is no longer in your account: stopped managing it`); }
    this.prune();
    m.livePositions = out; m.myPositions = out; m.posTs = Date.now();
  }
  gameIdForTicker(t) {
    const suf = t.split("-").slice(1, 2).join(""), sport = sportOfTicker(t);
    for (const [id, gs] of Object.entries(this.mem.gs)) if (gs.suffix === suf && (gs.sport || "cfb") === sport) return id;
    return null;
  }
  merged() {
    const m = this.mem, now = Date.now();
    return m.sbGames.map(g => {
      const gs = m.gs[g.id], co = m.core[g.id];
      let out = { ...g, feed: "espn" }, ts = gs.sbTs;
      if (co && now - co.fetchedTs < 15000 && co.status && co.status.type && co.status.type.state !== "pre") {
        const c = CFB.applyEspnCore(g, co); if (CFB.feedProgress(c) >= CFB.feedProgress(out)) { out = c; ts = co.fetchedTs; }
      }
      const sig = [out.home.score, out.away.score, out.period, out.clock, out.possession, out.down, out.yardsToGoal].join("|");
      const scoreSig = out.home.score + "-" + out.away.score;
      if (gs.sig !== sig) { gs.sig = sig; gs.midAtChange = gs.lastMid; }
      if (gs.scoreSig && gs.scoreSig !== scoreSig) gs.lastScoreChangeTs = now;
      gs.scoreSig = scoreSig; gs.dataTs = ts;
      return out;
    });
  }

  // ── one loop pass ──────────────────────────────────────────────────────────
  async tick() {
    const live = this.s.mode === "live", cfg = this.cfg(), m = this.mem;
    await this.refreshEvents();
    await this.refreshScoreboard();
    // your real positions are read in both modes (paper only watches them); in paper a failed read must not stop the tick
    await Promise.all([this.refreshCore(), this.refreshMarkets(), hasCredentials(this.env) ? this.refreshLivePositions().catch(e => { if (live) throw e; }) : null]);
    const games = this.merged(), now = Date.now();
    const positions = {};
    const mine = m.myPositions || {};
    if (live) { for (const [t, p] of Object.entries(mine)) if (p.botOwned) positions[t] = p; }
    else for (const [t, p] of Object.entries(this.s.paper.positions)) positions[t] = p;
    // positions you handed over: live sells them for real; paper only records what it would have done
    for (const [t, r] of Object.entries(this.s.managed)) {
      const p = mine[t]; if (!p || p.botOwned || (!live && this.s.shadow.done[t])) continue;
      positions[t] = { ...p, manual: true, shadow: !live, tpPrice: r.tpPrice, slPrice: r.slPrice, trailArm: r.trailArm, trailGive: r.trailGive, peakBid: r.peakBid || p.avgCost };
    }
    let open = 0;
    for (const [t, p] of Object.entries(positions)) { const mk = (m.markets[p.gameId] || []).find(x => x.ticker === t); const q = mk && CFB.sideQuotes(mk, p.side); if (q && q.bid != null) open += (q.bid - p.avgCost) * p.count / 100; }
    const book = live ? this.s.live : this.s.paper;
    const en = this.s.enabled || {};
    const input = { now, cfg, killed: this.s.killed, paused: !this.s.entries, positions, cooldowns: this.s.cooldowns, dailyPnl: (book.realized || 0) + open,
      games: games.map(g => { const gs = m.gs[g.id] || {};
        return { g, pre: this.s.pre[g.id], dataTs: gs.dataTs, lastScoreChangeTs: gs.lastScoreChangeTs, freezeUntil: gs.freezeUntil,
                 markets: m.markets[g.id] || [], marketTs: m.marketTs[g.id] || 0, enabled: !!(en.all || en[g.id]) }; }) };
    const res = CFB.decide(input);
    for (const ev of res.evals) { const p = positions[ev.ticker]; if (!p) continue; const mk = (m.markets[ev.gameId] || []).find(x => x.ticker === ev.ticker); const b = mk && CFB.sideQuotes(mk, p.side).bid;
      if (b > (p.peakBid || 0)) { p.peakBid = b; if (p.manual && this.s.managed[ev.ticker]) this.s.managed[ev.ticker].peakBid = b; else if (live && this.s.live.meta[ev.ticker]) this.s.live.meta[ev.ticker].peakBid = b; } }
    const acts = res.actions.sort((x, y) => (x.type === "sell" ? 0 : 1) - (y.type === "sell" ? 0 : 1));
    const seen = {};
    for (const a of acts) {
      if (a.type === "buy") {
        seen[a.ticker] = (m.seen[a.ticker] || 0) + 1;
        if (!a.lead && seen[a.ticker] < cfg.confirmTicks) continue;
        if (now - (this.s.startedAt || 0) < 15000) continue;   // warm-up: no state history yet
      }
      const g = games.find(x => x.id === a.gameId), mk = (m.markets[a.gameId] || []).find(x => x.ticker === a.ticker);
      try { if (a.manual && !live) this.shadowSell(a, positions[a.ticker], label(g, mk)); else if (live) await this.liveExecute(a, label(g, mk), cfg); else this.paperFill(a, label(g, mk), cfg); }
      catch (e) { this.log("error", `${a.type} ${a.ticker}: ${e.message}`); }
    }
    m.seen = seen;
    if (this.s.killed && !res.actions.some(a => a.type === "sell") && Object.keys(positions).length === 0) {
      this.s.killed = false; this.s.running = false; this.log("info", "Kill switch complete: all bot positions closed, runner stopped.");
    }
  }

  afterSell(a, cfg) {
    const cd = this.s.cooldowns, now = Date.now();
    cd[a.ticker] = { until: now + cfg.cooldownSecs * 1000, exits: ((cd[a.ticker] || {}).exits || 0) + 1 };
    if (/^stop loss/.test(a.reason)) { const n = (cd["stops:" + a.gameId] || 0) + 1; cd["stops:" + a.gameId] = n;
      cd["game:" + a.gameId] = { until: now + (n >= cfg.maxStopsPerGame ? 12 * 3600e3 : cfg.gameTimeoutSecs * 1000) };
      if (n >= cfg.maxStopsPerGame) this.log("info", `${n} stop-losses in game ${a.gameId}: no more entries in it tonight`); }
    for (const [k, v] of Object.entries(cd)) if (v && v.until && v.until < now - 3600e3) delete cd[k];
  }
  shadowSell(a, p, L) {
    const pnl = (a.limit - p.avgCost) * p.count / 100;
    this.s.shadow.trades.unshift({ ts: Date.now(), ticker: a.ticker, label: L, side: p.side, count: p.count, entry: p.avgCost, exit: a.limit, pnl, reason: a.reason, shadow: true });
    if (this.s.shadow.trades.length > 100) this.s.shadow.trades.length = 100;
    this.s.shadow.done[a.ticker] = true;
    this.log("info", `PAPER: would sell your ${p.count}× ${L} ${p.side.toUpperCase()} @ ${a.limit}¢ (cost ${p.avgCost}¢, ${pnl >= 0 ? "+" : "-"}$${Math.abs(pnl).toFixed(2)}) — ${a.reason}. Nothing was sold.`);
  }
  paperFill(a, L, cfg) {
    const book = this.s.paper, fee = CFB.feeCents(a.limit, a.count, cfg.feeRate) / 100;
    if (a.type === "buy") {
      book.positions[a.ticker] = { side: a.side, count: a.count, avgCost: a.limit, peakBid: a.limit, openedAt: Date.now(), gameId: a.gameId, fees: fee, lead: !!a.lead, tpPrice: a.takeProfitPrice, label: L };
      book.realized -= fee;
      this.log("buy", `PAPER BUY ${a.count}× ${L} ${a.side.toUpperCase()} @ ${a.limit}¢ — ${a.reason}`);
    } else {
      const p = book.positions[a.ticker]; if (!p) return;
      const pnl = (a.limit - p.avgCost) * p.count / 100 - fee;
      book.realized += pnl;
      book.trades.unshift({ ts: Date.now(), ticker: a.ticker, label: L, side: p.side, count: p.count, entry: p.avgCost, exit: a.limit, pnl: pnl - (p.fees || 0), lead: !!p.lead, reason: a.reason });
      if (book.trades.length > 300) book.trades.length = 300;
      delete book.positions[a.ticker];
      this.log(pnl - (p.fees || 0) >= 0 ? "win" : "loss", `PAPER CASH OUT ${p.count}× ${L} @ ${a.limit}¢ (cost ${p.avgCost}¢) ${(pnl - (p.fees || 0)).toFixed(2)} — ${a.reason}`);
      this.afterSell(a, cfg);
    }
  }
  async order(body) {
    const err = checkOrder(this.env, body); if (err) throw new Error(err);
    const { closing, ...send } = body;
    const r = await kalshiFetch(this.env, "POST", "/portfolio/events/orders", { ...send, self_trade_prevention_type: "taker_at_cross", client_order_id: crypto.randomUUID() });
    const d = JSON.parse(r.text || "{}");
    if (r.status >= 300) throw new Error((d.error && (d.error.message || d.error.code)) || "HTTP " + r.status);
    return d.order || d;
  }
  async liveExecute(a, L, cfg) {
    const meta = this.s.live.meta;
    if (a.type === "buy") {
      const res = await this.order({ ticker: a.ticker, ...toOrder("buy", a.side, a.limit, a.count), time_in_force: "immediate_or_cancel" });
      const filled = parseFloat(res.fill_count_fp || res.fill_count || 0);
      if (!(filled > 0)) { this.log("info", `No fill: ${L} ${a.side.toUpperCase()} @ ${a.limit}¢ (book moved)`); return; }
      const avgYes = res.average_fill_price != null ? Math.round(parseFloat(res.average_fill_price) * 100) : null;
      const avgSide = avgYes == null ? a.limit : a.side === "yes" ? avgYes : 100 - avgYes;
      meta[a.ticker] = { botOwned: true, avgCost: avgSide, peakBid: avgSide, openedAt: Date.now(), gameId: a.gameId, label: L, lead: !!a.lead, tpPrice: a.takeProfitPrice };
      this.log("buy", `LIVE BUY ${filled}× ${L} ${a.side.toUpperCase()} @ ${avgSide}¢ — ${a.reason}`);
      if (cfg.restingTakeProfit && Math.floor(filled) >= 1) {
        const tp = a.takeProfitPrice || Math.min(99, avgSide + cfg.takeProfit);
        try { const r2 = await this.order({ ticker: a.ticker, ...toOrder("sell", a.side, tp, Math.floor(filled)), time_in_force: "good_till_canceled", closing: true });
          meta[a.ticker].tpOrderId = r2.order_id; this.log("info", `Resting take-profit: sell ${Math.floor(filled)}× ${L} @ ${tp}¢`); }
        catch (e) { this.log("error", `Resting take-profit not placed: ${e.message}`); }
      }
      this.mem.posTs = 0;
    } else {
      const mt = meta[a.ticker] || { avgCost: a.limit - (a.gain || 0) };
      if (mt.tpOrderId) { try { await kalshiFetch(this.env, "DELETE", `/portfolio/events/orders/${mt.tpOrderId}?market_ticker=${a.ticker}`); } catch (e) {} mt.tpOrderId = null; }
      const limit = Math.max(1, a.limit - (cfg.exitSlippage || 1));
      const res = await this.order({ ticker: a.ticker, ...toOrder("sell", a.side, limit, a.count), time_in_force: "immediate_or_cancel", reduce_only: true });
      const filled = parseFloat(res.fill_count_fp || res.fill_count || 0);
      if (!(filled > 0)) { this.log("info", `Cash-out not filled: ${L} @ ${limit}¢ — will retry`); return; }
      const avgYes = res.average_fill_price != null ? Math.round(parseFloat(res.average_fill_price) * 100) : null;
      const avgSide = avgYes == null ? limit : a.side === "yes" ? avgYes : 100 - avgYes;
      const pnl = (avgSide - (mt.avgCost || avgSide)) * filled / 100;
      this.s.live.realized += pnl;
      this.s.live.trades.unshift({ ts: Date.now(), ticker: a.ticker, label: L, side: a.side, count: filled, entry: mt.avgCost, exit: avgSide, pnl, lead: !!mt.lead, reason: a.reason });
      if (this.s.live.trades.length > 300) this.s.live.trades.length = 300;
      this.log(pnl >= 0 ? "win" : "loss", `LIVE CASH OUT ${filled}× ${L} @ ${avgSide}¢ (cost ${mt.avgCost}¢) ${pnl.toFixed(2)} — ${a.reason}`);
      if (filled >= a.count - 1e-9) { Reflect.deleteProperty(meta, a.ticker); if (a.manual) { this.s.managed[a.ticker] = undefined; this.prune(); } }
      this.afterSell(a, cfg);
      this.mem.posTs = 0;
    }
  }
}

// Only numeric/boolean engine settings from DEFAULT_CONFIG are accepted (plus kinds).
function sanitizeCfg(c) {
  const out = {};
  for (const [k, v] of Object.entries(c || {})) {
    const d = CFB.DEFAULT_CONFIG[k];
    if (d === undefined) continue;
    if (typeof d === "number" && isFinite(+v)) out[k] = +v;
    else if (typeof d === "boolean") out[k] = !!v;
    else if (k === "kinds" && v && typeof v === "object") out.kinds = { win: !!v.win, spread: !!v.spread, total: !!v.total };
  }
  // hard ceilings the page can't raise
  out.maxStake = Math.min(out.maxStake ?? CFB.DEFAULT_CONFIG.maxStake, 25);
  out.maxTotalExposure = Math.min(out.maxTotalExposure ?? CFB.DEFAULT_CONFIG.maxTotalExposure, 150);
  return out;
}
