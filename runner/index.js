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
// Live orders go through lib/kalshi.js checkOrder, so KALSHI_TRADING_ENABLED=1 and the order cap still apply.
import CFB from "../js/cfb-engine.js";
import { kalshiFetch, hasCredentials, checkOrder } from "../lib/kalshi.js";

const K = "https://api.elections.kalshi.com/trade-api/v2";
const SB = "https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?groups=80&limit=300";
const SUMMARY = "https://site.api.espn.com/apis/site/v2/sports/football/college-football/summary?event=";
const CORE = "https://sports.core.api.espn.com/v2/sports/football/leagues/college-football/events/";
const SERIES = ["KXNCAAFGAME", "KXNCAAFSPREAD", "KXNCAAFTOTAL"];
const TICK_MS = 1500, IDLE_MS = 60000;

const J = async (u) => { const r = await fetch(u, { headers: { Accept: "application/json", "User-Agent": "sharp-sim-runner" }, signal: AbortSignal.timeout(6000) });   // a hung feed must not stall the tick if (!r.ok) throw new Error(r.status + " " + u.split("?")[0]); return r.json(); };
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
    });
  }
  cfg() { return { ...CFB.DEFAULT_CONFIG, ...(this.s.cfg || {}) }; }
  log(kind, msg) { this.s.log.unshift({ ts: Date.now(), kind, msg }); if (this.s.log.length > 400) this.s.log.length = 400; }
  async save() { await this.state.storage.put("s", this.s); }

  async fetch(request) {
    await this.ready;
    const url = new URL(request.url), path = url.pathname.replace(/^\/+/, "").replace(/^api\/runner\/?/, "");
    const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};
    if (path === "status" || path === "") return json(this.status(url.searchParams.get("log") !== "0"));
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
      Object.assign(this.s, { running: true, mode, killed: false, startedAt: Date.now() });
      this.mem.seen = {};
      this.log("info", `Server runner started (${mode.toUpperCase()})`);
      await this.save(); await this.state.storage.setAlarm(Date.now() + 100);
      return json(this.status(false));
    }
    if (path === "stop") { this.s.running = false; this.log("info", "Server runner stopped"); await this.save(); return json(this.status(false)); }
    if (path === "kill") { this.s.killed = true; this.s.running = true; this.log("info", "Kill switch: cashing out every bot position"); await this.save(); await this.state.storage.setAlarm(Date.now() + 100); return json(this.status(false)); }
    if (path === "config") { if (body.cfg) this.s.cfg = sanitizeCfg(body.cfg); if (body.enabled) this.s.enabled = body.enabled; await this.save(); return json(this.status(false)); }
    if (path === "reset-paper") { this.s.paper = { positions: {}, realized: 0, trades: [] }; this.log("info", "Paper ledger reset"); await this.save(); return json(this.status(false)); }
    return json({ error: "unknown route " + path }, 404);
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
    return { running: s.running, mode: s.mode, killed: s.killed, startedAt: s.startedAt, lastTick: s.lastTick, tickMs: s.tickMs, errors: s.errors,
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
      const anyLive = this.mem.sbGames.some(g => g.state === "in" || (g.state === "pre" && new Date(g.date) - Date.now() < 900e3));
      const hasPos = Object.keys(this.s.mode === "live" ? this.s.live.meta : this.s.paper.positions).length > 0;
      await this.state.storage.setAlarm(Date.now() + (anyLive || hasPos || this.s.killed ? Math.max(200, TICK_MS - this.s.tickMs) : IDLE_MS));
    }
  }

  // ── feeds ────────────────────────────────────────────────────────────────
  async refreshEvents() {
    const m = this.mem; if (Date.now() - m.eventsTs < 300000 && m.events.length) return;
    m.events = (await J(K + "/events?series_ticker=KXNCAAFGAME&status=open&limit=200")).events || []; m.eventsTs = Date.now();
  }
  async refreshScoreboard() {
    const m = this.mem; if (Date.now() - m.sbTs < 5000) return;
    const d = await J(SB + "&_=" + Date.now());
    m.sbGames = (d.events || []).map(CFB.parseEspnEvent).filter(g => g && (g.state === "in" || (g.state === "pre" && new Date(g.date) - Date.now() < 3600e3) || (g.state === "post" && Date.now() - new Date(g.date) < 6 * 3600e3)));
    m.sbTs = Date.now();
    for (const g of m.sbGames) {
      const gs = m.gs[g.id] = m.gs[g.id] || {}; gs.sbTs = m.sbTs;
      if (!gs.suffix) {
        let best = null; for (const e of m.events) { const sc = CFB.matchEventScore(e.title, g); if (!best || sc > best.sc) best = { sc, e }; }
        if (best && best.sc >= 0.6) gs.suffix = best.e.event_ticker.split("-").slice(1).join("-");
      }
      if (!this.s.pre[g.id] && g.state !== "post") {
        if (g.spreadHome != null && g.total != null) this.s.pre[g.id] = { spreadHome: g.spreadHome, total: g.total };
        else try { const s = await J(SUMMARY + g.id); const pc = (s.pickcenter || [])[0];
          this.s.pre[g.id] = pc && pc.spread != null ? { spreadHome: -Number(pc.spread), total: Number(pc.overUnder) } : { spreadHome: null, total: null }; } catch (e) {}
      }
    }
  }
  async refreshCore() {
    const m = this.mem;
    await Promise.all(m.sbGames.filter(g => g.state === "in").map(async g => {
      const base = CORE + g.id + "/competitions/" + g.id + "/";
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
    const lists = await Promise.all(SERIES.map(s => J(`${K}/markets?series_ticker=${s}&status=open&limit=1000`)));
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
      const t = p.ticker; if (!/^KXNCAAF(GAME|SPREAD|TOTAL)-/.test(t)) continue;
      const pos = parseFloat(p.position_fp != null ? p.position_fp : p.position || 0); if (!pos) continue;
      const count = Math.abs(pos), mt = meta[t] || {};
      const exposure = parseFloat(p.market_exposure_dollars != null ? p.market_exposure_dollars : (p.market_exposure || 0) / 100);
      const gameId = mt.gameId || this.gameIdForTicker(t);
      out[t] = { ...mt, side: pos > 0 ? "yes" : "no", count, avgCost: mt.avgCost || Math.round(exposure / count * 100), gameId,
                 unmanaged: !mt.botOwned && !cfg.manageManual, peakBid: mt.peakBid || 0, openedAt: mt.openedAt || Date.now() };
    }
    for (const t of Object.keys(meta)) if (!out[t]) delete meta[t];   // settled or sold elsewhere
    m.livePositions = out; m.posTs = Date.now();
  }
  gameIdForTicker(t) {
    const suf = t.split("-").slice(1, 2).join("");
    for (const [id, gs] of Object.entries(this.mem.gs)) if (gs.suffix === suf) return id;
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
    await Promise.all([this.refreshCore(), this.refreshMarkets(), live ? this.refreshLivePositions() : null]);
    const games = this.merged(), now = Date.now();
    const positions = {};
    const src = live ? (m.livePositions || {}) : this.s.paper.positions;
    for (const [t, p] of Object.entries(src)) if (!p.unmanaged) positions[t] = p;
    let open = 0;
    for (const [t, p] of Object.entries(positions)) { const mk = (m.markets[p.gameId] || []).find(x => x.ticker === t); const q = mk && CFB.sideQuotes(mk, p.side); if (q && q.bid != null) open += (q.bid - p.avgCost) * p.count / 100; }
    const book = live ? this.s.live : this.s.paper;
    const en = this.s.enabled || {};
    const input = { now, cfg, killed: this.s.killed, positions, cooldowns: this.s.cooldowns, dailyPnl: (book.realized || 0) + open,
      games: games.map(g => { const gs = m.gs[g.id] || {};
        return { g, pre: this.s.pre[g.id], dataTs: gs.dataTs, lastScoreChangeTs: gs.lastScoreChangeTs, freezeUntil: gs.freezeUntil,
                 markets: m.markets[g.id] || [], marketTs: m.marketTs[g.id] || 0, enabled: !!(en.all || en[g.id]) }; }) };
    const res = CFB.decide(input);
    for (const ev of res.evals) { const p = positions[ev.ticker]; if (!p) continue; const mk = (m.markets[ev.gameId] || []).find(x => x.ticker === ev.ticker); const b = mk && CFB.sideQuotes(mk, p.side).bid;
      if (b > (p.peakBid || 0)) { p.peakBid = b; if (live && this.s.live.meta[ev.ticker]) this.s.live.meta[ev.ticker].peakBid = b; } }
    const acts = res.actions.sort((x, y) => (x.type === "sell" ? 0 : 1) - (y.type === "sell" ? 0 : 1));
    const seen = {};
    for (const a of acts) {
      if (a.type === "buy") {
        seen[a.ticker] = (m.seen[a.ticker] || 0) + 1;
        if (!a.lead && seen[a.ticker] < cfg.confirmTicks) continue;
        if (now - (this.s.startedAt || 0) < 15000) continue;   // warm-up: no state history yet
      }
      const g = games.find(x => x.id === a.gameId), mk = (m.markets[a.gameId] || []).find(x => x.ticker === a.ticker);
      try { if (live) await this.liveExecute(a, label(g, mk), cfg); else this.paperFill(a, label(g, mk), cfg); }
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
      const mt = meta[a.ticker] || {};
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
      if (filled >= a.count - 1e-9) delete meta[a.ticker];
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
