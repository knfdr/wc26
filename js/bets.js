// Sharp Sim shared betting helpers, used by every sport page and the settings page.
//   Grades: how good a bet is, from the model's chance to cash and the price you pay for it.
//   Sizing: a suggested dollar amount from the sport's base bet (settings) and the grade.
//   Settings + record: stored in the site's GitHub gist (synced across devices), cached in localStorage.
//   BetButton: tap -> confirm sheet -> order on Kalshi through /api/kx (the server enforces its own dollar cap).
// Plain JS (no JSX) so it loads with a normal <script src="js/bets.js"> after React.
(function (root) {
  "use strict";

  const SPORTS = { nfl: "NFL", cfb: "College football", mlb: "MLB", wnba: "WNBA", golf: "Golf" };
  // gist "sport" values used by older logged bets
  const SPORT_KEY = { NFL: "nfl", CFB: "cfb", MLB: "mlb", WNBA: "wnba", GOLF: "golf", WC: "wc" };

  const DEFAULTS = {
    v: 1,
    baseBet: { nfl: 20, cfb: 20, mlb: 20, wnba: 20, golf: 10 },
    // how much of the base bet each grade gets
    mult: { STRONG: 2, GOOD: 1.5, SMALL: 0.5 },
    maxMult: 3,                         // never suggest more than this × base
    strong: { minEdge: 7, minChance: 55 },
    good: { minEdge: 4, minChance: 45 },
    small: { minEdge: 2 },
    hideWide: true,                     // hide markets whose bid/ask gap is wider than 6¢ (prices there aren't real)
    logPicks: true,                     // add STRONG and GOOD picks to the win/loss record automatically
  };

  // CSS variables from css/sharp.css, so grades follow light/dark. HEX holds plain fallbacks for code that needs a literal color.
  const C = { STRONG: "var(--strong)", GOOD: "var(--good)", SMALL: "var(--small)", NONE: "var(--none)", AVOID: "var(--avoid)" };
  const HEX = { STRONG: "#25c466", GOOD: "#4593f5", SMALL: "#e5b02e", NONE: "#6b7482", AVOID: "#f2546b" };
  const LABEL = { STRONG: "STRONG BET", GOOD: "GOOD BET", SMALL: "SMALL EDGE", NONE: "NO EDGE", AVOID: "AVOID" };
  const BLURB = {
    STRONG: "Likely to cash and priced well below the model's chance. The best bets on the board.",
    GOOD: "A solid chance to cash at a good price.",
    SMALL: "Priced a little below the model's chance, or a long shot. Bet small or skip.",
    NONE: "The price is about right. No reason to bet it.",
    AVOID: "The price is higher than the model's chance. Don't bet it.",
  };
  const ORDER = ["STRONG", "GOOD", "SMALL", "NONE", "AVOID"];

  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const merge = (a, b) => { const o = { ...a }; for (const k in b || {}) o[k] = b[k] && typeof b[k] === "object" && !Array.isArray(b[k]) && a[k] && typeof a[k] === "object" ? merge(a[k], b[k]) : b[k]; return o; };

  // ── Settings ────────────────────────────────────────────────────────────────
  const LS_SETTINGS = "sharp_settings_v1";
  const GIST_SETTINGS = "sharpsim_settings.json", GIST_BETS = "sharpsim_bets.json";
  let settings = (() => { try { return merge(DEFAULTS, JSON.parse(localStorage.getItem(LS_SETTINGS) || "null")); } catch (e) { return merge(DEFAULTS, null); } })();
  const listeners = new Set();
  function getSettings() { return settings; }
  function onSettings(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  function applySettings(s) { settings = merge(DEFAULTS, s); try { localStorage.setItem(LS_SETTINGS, JSON.stringify(settings)); } catch (e) {} listeners.forEach(f => f(settings)); }
  // one shared read: every component on a page asks at once, so share the request in flight and cache it 20s
  let gistCache = null, gistInflight = null;
  function gistRead() {
    if (gistCache && Date.now() - gistCache.ts < 20000) return Promise.resolve(gistCache.data);
    if (!gistInflight) gistInflight = fetch("/api/gist").then(async r => { if (!r.ok) throw new Error("gist read " + r.status); const data = await r.json(); gistCache = { ts: Date.now(), data }; return data; })
      .finally(() => { gistInflight = null; });
    return gistInflight;
  }
  async function gistWriteFile(name, obj) {
    const r = await fetch("/api/gist", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ files: { [name]: { content: JSON.stringify(obj, null, 2) } } }) });
    gistCache = null;
    if (!r.ok) throw new Error("gist write " + r.status);
  }
  let settingsLoad = null;   // once per page load
  function loadSettings() { return settingsLoad || (settingsLoad = loadSettingsNow()); }
  async function loadSettingsNow() {
    try { const d = await gistRead(); const f = d.files && d.files[GIST_SETTINGS]; if (f && f.content) applySettings(JSON.parse(f.content)); } catch (e) {}
    return settings;
  }
  async function saveSettings(s) { applySettings(s); await gistWriteFile(GIST_SETTINGS, settings); return settings; }

  // ── Grades and sizing ───────────────────────────────────────────────────────
  // p: model chance to cash (0-1). price: what one $1 contract of this side costs, in cents.
  function grade(p, price, s) {
    s = s || settings;
    if (p == null || price == null || !(price > 0) || !(price < 100)) return null;
    const chance = p * 100, edge = chance - price;
    let key;
    if (edge >= s.strong.minEdge && chance >= s.strong.minChance) key = "STRONG";
    else if (edge >= s.good.minEdge && chance >= s.good.minChance) key = "GOOD";
    else if (edge >= s.small.minEdge) key = "SMALL";
    else if (edge > -s.small.minEdge) key = "NONE";
    else key = "AVOID";
    const longShot = chance < 30;
    return { key, label: LABEL[key], color: C[key], blurb: BLURB[key], chance, price, edge, longShot, rank: ORDER.indexOf(key) };
  }
  // Suggested dollars: base × grade multiplier, nudged by how far past the grade's edge bar it is, capped at maxMult × base.
  function stake(g, sport, s) {
    s = s || settings;
    if (!g || !s.mult[g.key]) return 0;
    const base = +s.baseBet[sport] || 0;
    const bar = g.key === "STRONG" ? s.strong.minEdge : g.key === "GOOD" ? s.good.minEdge : s.small.minEdge;
    const nudge = clamp(g.edge / (bar * 1.5), 0.75, 1.25);
    const usd = Math.min(base * s.mult[g.key] * nudge, base * s.maxMult);
    return Math.max(1, Math.round(usd));
  }
  // What a dollar amount buys at a price: whole contracts, cost, payout if it wins.
  function ticket(dollars, price) {
    const count = Math.max(0, Math.floor(dollars / (price / 100) + 1e-9));
    const cost = count * price / 100;
    return { count, cost, payout: count, profit: count - cost };
  }
  const money = (x) => "$" + (Math.abs(x) >= 100 ? Math.round(x).toLocaleString() : x.toFixed(2).replace(/\.00$/, ""));

  // ── Kalshi ──────────────────────────────────────────────────────────────────
  let kxStatus = null, kxPromise = null;
  function kalshiStatus() {
    if (kxStatus) return Promise.resolve(kxStatus);
    if (!kxPromise) kxPromise = fetch("/api/kx/_status").then(r => r.json()).then(d => (kxStatus = d)).catch(() => (kxStatus = { credentials: false }));
    return kxPromise;
  }
  // Buy one side at the current ask. Fills now or not at all (no resting order left behind).
  async function placeBet({ ticker, side, price, count }) {
    const yesPrice = side === "yes" ? price : 100 - price;
    const body = { ticker, side: side === "yes" ? "bid" : "ask", price: (clamp(yesPrice, 1, 99) / 100).toFixed(2), count: String(count), time_in_force: "immediate_or_cancel" };
    const r = await fetch("/api/kx/portfolio/events/orders", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const ct = r.headers.get("content-type") || "";
    const d = ct.includes("json") ? await r.json() : { error: "The site's server didn't answer (HTTP " + r.status + ")" };
    if (!r.ok) throw new Error(typeof d.error === "string" ? d.error : (d.error && d.error.message) || JSON.stringify(d.error || d));
    const filled = parseFloat(d.fill_count_fp || d.fill_count || 0);
    const avg = d.average_fill_price != null ? Math.round(parseFloat(d.average_fill_price) * 100) : price;
    return { filled, avg: side === "yes" ? avg : (d.average_fill_price != null ? 100 - avg : price), raw: d };
  }

  // ── Record (STRONG and GOOD picks only) ─────────────────────────────────────
  // Older bets were graded LOCK / HIGH; they count as STRONG / GOOD so the record keeps its history.
  const recTier = (t) => t === "LOCK" || t === "STRONG" ? "STRONG" : t === "HIGH" || t === "GOOD" ? "GOOD" : null;
  async function readBets() { const d = await gistRead(); const f = d.files && d.files[GIST_BETS]; return f && f.content ? JSON.parse(f.content) : []; }
  function record(bets) {
    const out = { all: blank(), bySport: {} };
    function blank() { return { w: 0, l: 0, p: 0, pending: 0, STRONG: { w: 0, l: 0, p: 0, pending: 0 }, GOOD: { w: 0, l: 0, p: 0, pending: 0 } }; }
    for (const b of bets || []) {
      const t = recTier(b.tier); if (!t) continue;
      // old sportsbook-era picks still pending can never settle now: leave them out
      if (b.result === "pending" && !b.ticker && (b.gameDate || b.loggedAt) && Date.now() - new Date(b.gameDate || b.loggedAt) > 14 * 864e5) continue;
      const sp = SPORT_KEY[b.sport] || String(b.sport || "").toLowerCase();
      const k =b.result === "win" ? "w" : b.result === "loss" ? "l" : b.result === "push" ? "p" : "pending";
      for (const r of [out.all, out.bySport[sp] || (out.bySport[sp] = blank())]) { r[k]++; r[t][k]++; }
    }
    return out;
  }
  const winPct = (r) => r.w + r.l ? Math.round(100 * r.w / (r.w + r.l)) + "%" : "—";
  // Add new STRONG/GOOD picks to the record (one entry per market per game; the first grade sticks).
  // pick: { sport: "nfl", gameId, gameDate, home, away, market, ticker, side, chance, price, tier }
  let logQueue = Promise.resolve();
  function logPicks(picks) {
    if (!settings.logPicks) return Promise.resolve(0);
    const add = (picks || []).filter(p => recTier(p.tier));
    if (!add.length) return Promise.resolve(0);
    logQueue = logQueue.then(async () => {
      const bets = await readBets();
      const key = (b) => (b.ticker ? b.ticker + "|" + (b.side || "") : (b.gameId + "|" + b.market + "|" + b.gameDate));
      const have = new Set(bets.map(key));
      const fresh = add.filter(p => !have.has(key(p))).map(p => ({
        id: Date.now() + "_" + Math.random().toString(36).slice(2, 7), sport: p.sport.toUpperCase(), gameId: p.gameId,
        homeTeam: p.home, awayTeam: p.away, market: p.market, ticker: p.ticker || null, side: p.side || null,
        simPct: p.chance.toFixed(1) + "%", price: p.price, tier: p.tier, loggedAt: new Date().toISOString(),
        result: "pending", resolvedAt: null, finalScore: null, gameDate: p.gameDate || new Date().toLocaleDateString("en-CA"),
      }));
      if (!fresh.length) return 0;
      await gistWriteFile(GIST_BETS, bets.concat(fresh));
      return fresh.length;
    }).catch(() => 0);
    return logQueue;
  }

  // ── React UI ────────────────────────────────────────────────────────────────
  // Styling lives in css/sharp.css (classes + tokens). Grade colors are CSS variables, so they follow light/dark.
  const R = root.React; if (!R) { root.SharpBets = api(); return; }
  const h = R.createElement, { useState, useEffect } = R;
  const gv = (g) => ({ "--g": g && g.color ? g.color : "var(--none)" });
  const pct = (x) => Math.round(x) + "%";
  const signed = (x, d) => (x >= 0 ? "+" : "−") + Math.abs(x).toFixed(d == null ? 1 : d);

  function useSettings() {
    const [s, setS] = useState(settings);
    useEffect(() => { const off = onSettings(setS); loadSettings(); return off; }, []);
    return s;
  }
  function useKalshi() {
    const [k, setK] = useState(kxStatus);
    useEffect(() => { let on = true; kalshiStatus().then(d => on && setK(d)); return () => { on = false; }; }, []);
    return k;
  }

  function GradeBadge({ g, small, solid }) {
    if (!g) return null;
    return h("span", { title: g.blurb, className: "grade" + (small ? " sm" : "") + (solid ? " solid" : ""), style: gv(g) }, g.label);
  }
  // "62% chance to cash · costs 55¢ · edge +7¢", for one line under a pick
  function ChanceLine({ g }) {
    if (!g) return null;
    return h("span", { className: "small text-2" },
      h("b", { style: { color: g.color } }, pct(g.chance) + " chance to cash"), " · costs " + Math.round(g.price) + "¢ · edge " + signed(g.edge) + "¢" + (g.longShot ? " · long shot" : ""));
  }
  // The model's chance to cash as a bar, with Kalshi's price as a tick on the same 0-100 scale.
  // The striped gap between the tick and the end of the bar is the edge.
  function ChanceBar({ g, compact }) {
    if (!g) return null;
    const c = clamp(g.chance, 0, 100), p = clamp(g.price, 0, 100);
    const lo = Math.min(c, p), hi = Math.max(c, p);
    const label = `Model ${pct(c)} chance to cash, Kalshi price ${Math.round(p)}¢, edge ${signed(g.edge)}¢`;
    const track = h("div", { className: "cvp-track", role: "img", "aria-label": label },
      h("div", { className: "cvp-fill", style: { width: lo + "%" } }),
      g.edge > 0 && h("div", { className: "cvp-gap", style: { left: lo + "%", width: (hi - lo) + "%" } }),
      g.edge <= 0 && h("div", { className: "cvp-fill", style: { width: hi + "%", opacity: .25 } }),
      h("div", { className: "cvp-price", style: { left: p + "%" } }));
    if (compact) return h("div", { className: "cvp compact", style: gv(g), title: label }, track);
    return h("div", { className: "cvp", style: gv(g) },
      h("div", { className: "cvp-nums" },
        h("div", { className: "cvp-num" }, h("div", { className: "v" }, pct(c)), h("div", { className: "l" }, "Model chance")),
        h("div", { className: "cvp-num c cvp-edge" }, h("div", { className: "v" }, signed(g.edge) + "¢"), h("div", { className: "l" }, "Edge")),
        h("div", { className: "cvp-num r" }, h("div", { className: "v" }, Math.round(p) + "¢"), h("div", { className: "l" }, "Kalshi price"))),
      track,
      h("div", { className: "cvp-scale" }, h("span", null, "0"), h("span", null, "50"), h("span", null, "100")));
  }
  // Collapsible card explaining the grades, for the top of every sport page
  function GradeLegend({ sport, open }) {
    const s = useSettings();
    const sug = (k) => s.mult[k] && sport ? ` Suggested bet ${money(Math.round(s.baseBet[sport] * s.mult[k]))}.` : "";
    const row = (k, extra) => h("div", { key: k, className: "grade-row" },
      h("span", null, h(GradeBadge, { g: { key: k, label: LABEL[k], color: C[k], blurb: BLURB[k] } })),
      h("span", null, BLURB[k] + (extra ? " " + extra : "")));
    return h("details", { className: "explain", open: !!open, style: { marginBottom: 12 } },
      h("summary", null, h("span", { className: "chip" }, "?"), "How to read the picks"),
      h("div", { className: "body" },
        h("div", { className: "note", style: { marginBottom: 12 } },
          h(ChanceBar, { g: { color: C.GOOD, chance: 60, price: 50, edge: 10 } }),
          h("div", { style: { marginTop: 10 } }, "The bar is how often the model's simulations say the bet wins. The white tick is what Kalshi charges for a $1 contract. When the bar reaches past the tick, the bet is cheap for how likely it is: that gap is the ", h("b", null, "edge"), ". A 60% bet that costs 50¢ has a +10¢ edge.")),
        h("div", { className: "grade-rows" },
          row("STRONG", `Model ${s.strong.minChance}%+ to cash and ${s.strong.minEdge}¢+ under the price.${sug("STRONG")}`),
          row("GOOD", `Model ${s.good.minChance}%+ to cash and ${s.good.minEdge}¢+ under the price.${sug("GOOD")}`),
          row("SMALL", sug("SMALL").trim()),
          row("AVOID")),
        h("div", { className: "tiny muted", style: { marginTop: 12 } }, "Bet amounts scale from your base bet in ", h("a", { href: "settings.html", className: "link" }, "Settings"), ".")));
  }

  // Bet button + confirm sheet. pick: { ticker, side: "yes"|"no", price (cents for that side), chance (0-100), label, sport, grade }
  function BetButton({ pick, compact, block }) {
    const s = useSettings(), kx = useKalshi();
    const [open, setOpen] = useState(false);
    const [done, setDone] = useState(null);
    if (!pick || !pick.ticker || !(pick.price > 0 && pick.price < 100)) return null;
    if (done) return h("span", { className: "bet-done" }, "✓ " + done);
    const g = pick.grade || grade(pick.chance / 100, pick.price, s);
    const hot = g && (g.key === "STRONG" || g.key === "GOOD");
    const btn = h("button", { onClick: (e) => { e.stopPropagation(); setOpen(true); }, className: "bet-btn" + (hot ? " hot" : "") + (compact ? " sm" : ""), style: { ...gv(g && g.key !== "AVOID" ? g : null), ...(block ? { width: "100%" } : {}) } },
      "Bet " + money(stake(g, pick.sport, s) || (s.baseBet[pick.sport] || 10) * 0.5));
    return h(R.Fragment, null, btn, open && h(BetSheet, { pick, g, s, kx, onClose: () => setOpen(false), onDone: (msg) => { setOpen(false); setDone(msg); } }));
  }

  function BetSheet({ pick, g, s, kx, onClose, onDone }) {
    const suggested = stake(g, pick.sport, s) || Math.max(1, Math.round((s.baseBet[pick.sport] || 10) * 0.5));
    const cap = kx && kx.maxOrderDollars ? +kx.maxOrderDollars : Infinity;
    const [usd, setUsd] = useState(Math.min(suggested, cap));
    const [st, setSt] = useState({ busy: false, err: "" });
    const t = ticket(usd, pick.price);
    const ready = kx && kx.credentials && kx.tradingEnabled;
    const why = !kx ? "Checking your Kalshi connection…" : !kx.credentials ? "Kalshi isn't connected on the site's server yet (no API key)." : !kx.tradingEnabled ? "Betting is switched off on the site's server. Set KALSHI_TRADING_ENABLED=1 in Cloudflare to turn it on." : "";
    useEffect(() => { const k = (e) => e.key === "Escape" && onClose(); window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, []);
    async function confirm() {
      setSt({ busy: true, err: "" });
      try {
        const r = await placeBet({ ticker: pick.ticker, side: pick.side, price: pick.price, count: t.count });
        if (!(r.filled > 0)) { setSt({ busy: false, err: "The price moved before your order reached Kalshi, so nothing was bought. Close this and try again." }); return; }
        onDone(`Bought ${r.filled} @ ${r.avg}¢`);
      } catch (e) { setSt({ busy: false, err: e.message }); }
    }
    const step = (d) => setUsd(u => clamp(Math.round(u + d), 1, cap));
    const cell = (l, v, c) => h("div", null, h("div", { className: "l" }, l), h("div", { className: "v", style: c ? { color: c } : null }, v));
    return h("div", { className: "sheet-scrim", onClick: onClose },
      h("div", { className: "sheet", role: "dialog", "aria-modal": "true", "aria-label": "Place bet", onClick: (e) => e.stopPropagation() },
        h("div", { className: "sheet-grip" }),
        h("div", { className: "row", style: { marginBottom: 10 } },
          h(GradeBadge, { g }), h("span", { style: { flex: 1 } }),
          h("button", { onClick: onClose, className: "ss-icon-btn", "aria-label": "Close" }, "✕")),
        h("div", { style: { fontSize: 22, fontWeight: 700, letterSpacing: -0.3 } }, pick.label),
        pick.sub && h("div", { className: "small text-2", style: { marginTop: 2 } }, pick.sub),
        h(ChanceBar, { g }),
        h("div", { className: "label", style: { margin: "18px 0 8px" } }, "Amount"),
        h("div", { className: "stepper" },
          h("button", { onClick: () => step(-5), "aria-label": "Five dollars less" }, "−"),
          h("input", { type: "number", inputMode: "numeric", min: 1, value: usd, "aria-label": "Bet amount in dollars", onChange: (e) => setUsd(clamp(Math.round(+e.target.value || 0), 0, cap)) }),
          h("button", { onClick: () => step(5), "aria-label": "Five dollars more" }, "+")),
        h("div", { className: "row tiny muted", style: { marginTop: 8, minHeight: 32 } },
          h("span", { style: { flex: 1 } }, cap < Infinity ? `The site's server caps each bet at ${money(cap)}.` : `Suggested ${money(suggested)} from your base bet.`),
          usd !== suggested && h("button", { onClick: () => setUsd(Math.min(suggested, cap)), className: "btn btn-sm" }, "Use suggested " + money(suggested))),
        h("div", { className: "ticket" },
          cell("Contracts", t.count + " @ " + pick.price + "¢"), cell("You pay", money(t.cost)), cell("Pays if it wins", money(t.payout), "var(--strong)")),
        why && h("div", { className: "note warn", style: { marginBottom: 10 } }, why),
        st.err && h("div", { className: "note bad", style: { marginBottom: 10 } }, st.err),
        h("button", { disabled: !ready || st.busy || t.count < 1, onClick: confirm, className: "confirm-btn" },
          st.busy ? "Placing…" : t.count < 1 ? "Amount too small" : `Confirm ${money(t.cost)} bet on Kalshi`),
        h("div", { className: "tiny muted", style: { marginTop: 10, textAlign: "center" } }, "Buys at the current price or not at all. Nothing is left waiting on Kalshi.")));
  }

  // Sortable header cell: <SortTh k="edge" sort={sort} setSort={setSort}>Edge</SortTh>
  function SortTh({ k, sort, setSort, children, style, right }) {
    const on = sort && sort.k === k;
    return h("th", { onClick: k ? () => setSort(on ? { k, dir: -sort.dir } : { k, dir: -1 }) : undefined, className: (k ? "sortable" : "") + (right ? " r" : ""),
      "aria-sort": k ? (on ? (sort.dir < 0 ? "descending" : "ascending") : "none") : undefined, style: style || undefined },
      children, k ? h("span", { className: "arrow" }, on ? (sort.dir < 0 ? "▼" : "▲") : "↕") : null);
  }
  function sortRows(rows, sort, get) { const g = get || ((r, k) => r[k]); return rows.slice().sort((a, b) => { const x = g(a, sort.k), y = g(b, sort.k); return x == null ? 1 : y == null ? -1 : (x > y ? 1 : x < y ? -1 : 0) * sort.dir; }); }

  // Settled STRONG/GOOD picks in date order, with what a flat bet on each would have made (needs the price it was logged at).
  function history(bets, sport) {
    const out = [];
    for (const b of bets || []) {
      const t = recTier(b.tier); if (!t || (b.result !== "win" && b.result !== "loss")) continue;
      const sp = SPORT_KEY[b.sport] || String(b.sport || "").toLowerCase();
      if (sport && sp !== sport) continue;
      const price = +b.price;
      out.push({ t, sp, win: b.result === "win", date: b.gameDate || (b.resolvedAt || b.loggedAt || "").slice(0, 10), price: price > 0 && price < 100 ? price : null, label: b.market || "", game: [b.awayTeam, b.homeTeam].filter(Boolean).join(" @ ") });
    }
    return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }

  // Win/loss record of STRONG and GOOD picks for one sport (or all when sport is omitted), with a chart when there's history
  function RecordCard({ sport, bets: given, chart }) {
    const [bets, setBets] = useState(given || null);
    useEffect(() => { if (!given) readBets().then(setBets).catch(() => setBets(false)); }, []);
    if (bets === false) return h("div", { className: "note", style: { marginBottom: 12 } }, "The pick record couldn't be loaded right now.");
    if (!bets) return null;
    const rec = record(bets);
    const r = sport ? rec.bySport[sport] : rec.all;
    if (!r || !(r.w + r.l + r.p + r.pending)) return h("div", { className: "note", style: { marginBottom: 12 } }, "Your record starts here: STRONG and GOOD picks are tracked automatically once they're graded. None settled yet.");
    const UI = root.SharpUI;
    const hist = history(bets, sport);
    const tier = (k) => h("div", { key: k, className: "tile" },
      h("div", { className: "l" }, h(GradeBadge, { g: { key: k, label: LABEL[k], color: C[k] }, small: true })),
      h("div", { className: "v num", style: { marginTop: 4 } }, r[k].w + "–" + r[k].l, r[k].p ? h("span", { className: "small muted" }, " " + r[k].p + "P") : null),
      h("div", { className: "s" }, (r[k].w + r[k].l ? winPct(r[k]) + " won" : "none settled") + (r[k].pending ? " · " + r[k].pending + " pending" : "")));
    return h("div", { className: "card", style: { marginBottom: 12 } },
      h("div", { className: "row", style: { marginBottom: 12, alignItems: "baseline", flexWrap: "wrap" } },
        h("div", { className: "num", style: { fontSize: 30, fontWeight: 700, letterSpacing: -0.8, lineHeight: 1 } }, r.w + "–" + r.l, r.p ? h("span", { className: "small muted" }, " " + r.p + " push") : null),
        h("div", { className: "small text-2" }, r.w + r.l ? `${winPct(r)} won` : "No settled picks yet", r.pending ? h("span", { className: "muted" }, ` · ${r.pending} pending`) : null)),
      h("div", { className: "tiles" }, tier("STRONG"), tier("GOOD")),
      chart !== false && UI && UI.RecordChart && hist.length >= 2 && h("div", { style: { marginTop: 14 } }, h(UI.RecordChart, { hist, base: sport ? settings.baseBet[sport] : 20 })));
  }

  root.SharpBets = Object.assign(api(), { useSettings, useKalshi, GradeBadge, ChanceLine, ChanceBar, GradeLegend, BetButton, SortTh, sortRows, RecordCard, history });

  function api() {
    return { SPORTS, DEFAULTS, COLORS: C, HEX, LABELS: LABEL, BLURBS: BLURB, ORDER, getSettings, onSettings, loadSettings, saveSettings, grade, stake, ticket, money,
      kalshiStatus, placeBet, readBets, record, winPct, logPicks, recTier, americanToCents };
  }
  // Sportsbook odds (e.g. -150, +130) to the break-even price in cents, for pages that fall back to sportsbook lines
  function americanToCents(o) { o = parseFloat(String(o).replace(/^~/, "")); if (!isFinite(o) || o === 0) return null; return o < 0 ? 100 * -o / (-o + 100) : 100 * 100 / (o + 100); }
})(typeof window !== "undefined" ? window : globalThis);
if (typeof module !== "undefined") module.exports = globalThis.SharpBets || (typeof window !== "undefined" && window.SharpBets);
