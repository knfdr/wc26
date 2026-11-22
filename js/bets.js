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

  const C = { STRONG: "#22c55e", GOOD: "#38bdf8", SMALL: "#e8c547", NONE: "#4b6280", AVOID: "#ef4444" };
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
  const R = root.React; if (!R) { root.SharpBets = api(); return; }
  const h = R.createElement, { useState, useEffect } = R;
  const T = { bg: "#070b14", card: "#101d30", border: "#1a2a3e", text: "#dde5f0", muted: "#7a8ca8", dim: "#4b6280" };

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

  function GradeBadge({ g, small }) {
    if (!g) return null;
    return h("span", { title: g.blurb, style: { display: "inline-block", background: g.color + "22", border: "1px solid " + g.color + "55", color: g.color, fontSize: small ? 8 : 9, fontWeight: 700, letterSpacing: 1, padding: small ? "1px 5px" : "2px 7px", borderRadius: 3, whiteSpace: "nowrap" } }, g.label);
  }
  // "62% chance to cash" with the price, for one line under a pick
  function ChanceLine({ g }) {
    if (!g) return null;
    return h("span", { style: { fontSize: 10, color: T.muted } },
      h("b", { style: { color: g.color } }, g.chance.toFixed(0) + "% chance to cash"), " · costs " + g.price + "¢ · edge " + (g.edge >= 0 ? "+" : "") + g.edge.toFixed(1) + "¢" + (g.longShot ? " · long shot" : ""));
  }
  // Legend card explaining the grades, for the top of every sport page
  function GradeLegend({ sport }) {
    const s = useSettings();
    const row = (k, extra) => h("div", { key: k, style: { display: "flex", gap: 8, alignItems: "baseline", marginBottom: 5 } },
      h("span", { style: { minWidth: 86 } }, h(GradeBadge, { g: { key: k, label: LABEL[k], color: C[k], blurb: BLURB[k] } })),
      h("span", { style: { fontSize: 10, color: T.muted, lineHeight: 1.5 } }, BLURB[k] + (extra ? " " + extra : "")));
    const sug = (k) => s.mult[k] && sport ? `Suggested bet ${money(Math.round(s.baseBet[sport] * s.mult[k]))}.` : "";
    return h("div", { style: { background: T.card, border: "1px solid " + T.border, borderRadius: 6, padding: "12px 14px", marginBottom: 12 } },
      h("div", { style: { fontSize: 8, color: T.muted, letterSpacing: 2, marginBottom: 8 } }, "HOW TO READ THE PICKS"),
      row("STRONG", `Model ${s.strong.minChance}%+ to cash and ${s.strong.minEdge}¢+ under the price. ${sug("STRONG")}`),
      row("GOOD", `Model ${s.good.minChance}%+ to cash and ${s.good.minEdge}¢+ under the price. ${sug("GOOD")}`),
      row("SMALL", sug("SMALL")),
      row("AVOID"),
      h("div", { style: { fontSize: 9, color: T.dim, marginTop: 6, lineHeight: 1.5 } },
        "\"Chance to cash\" is how often the model's simulations say the bet wins. \"Edge\" is that chance minus the price in cents: a 60% bet that costs 50¢ has a +10¢ edge. Bet amounts scale from your base bet in ",
        h("a", { href: "settings.html", style: { color: "#38bdf8" } }, "Settings"), "."));
  }

  // Bet button + confirm sheet. pick: { ticker, side: "yes"|"no", price (cents for that side), chance (0-100), label, sport, grade }
  function BetButton({ pick, compact }) {
    const s = useSettings(), kx = useKalshi();
    const [open, setOpen] = useState(false);
    const [done, setDone] = useState(null);
    if (!pick || !pick.ticker || !(pick.price > 0 && pick.price < 100)) return null;
    if (done) return h("span", { style: { fontSize: 9, color: C.STRONG, fontWeight: 700, whiteSpace: "nowrap" } }, "✓ " + done);
    const g = pick.grade || grade(pick.chance / 100, pick.price, s);
    const strong = g && (g.key === "STRONG" || g.key === "GOOD");
    const btn = h("button", { onClick: (e) => { e.stopPropagation(); setOpen(true); }, style: {
      background: strong ? g.color + "22" : "transparent", border: "1px solid " + (g ? g.color : T.border) + (strong ? "aa" : "55"), color: g && g.key !== "AVOID" ? g.color : T.muted,
      fontSize: compact ? 9 : 10, fontWeight: 700, letterSpacing: 1, padding: compact ? "4px 8px" : "6px 12px", borderRadius: 4, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" } },
      "BET " + money(stake(g, pick.sport, s) || (s.baseBet[pick.sport] || 10) * 0.5));
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
    async function confirm() {
      setSt({ busy: true, err: "" });
      try {
        const r = await placeBet({ ticker: pick.ticker, side: pick.side, price: pick.price, count: t.count });
        if (!(r.filled > 0)) { setSt({ busy: false, err: "The price moved before your order reached Kalshi, so nothing was bought. Close this and try again." }); return; }
        onDone(`BOUGHT ${r.filled} @ ${r.avg}¢`);
      } catch (e) { setSt({ busy: false, err: e.message }); }
    }
    const step = (d) => setUsd(u => clamp(Math.round(u + d), 1, cap));
    const pill = { background: T.bg, border: "1px solid " + T.border, color: T.text, borderRadius: 4, padding: "8px 12px", fontSize: 13, cursor: "pointer", fontFamily: "inherit" };
    return h("div", { onClick: onClose, style: { position: "fixed", inset: 0, background: "#000a", zIndex: 1000, display: "flex", alignItems: "flex-end", justifyContent: "center" } },
      h("div", { onClick: (e) => e.stopPropagation(), style: { background: T.card, border: "1px solid " + T.border, borderRadius: "10px 10px 0 0", width: "100%", maxWidth: 460, padding: "18px 18px 22px", fontFamily: "'JetBrains Mono','SF Mono',monospace", color: T.text, boxSizing: "border-box" } },
        h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 } },
          h(GradeBadge, { g }), h("button", { onClick: onClose, style: { ...pill, padding: "2px 10px", fontSize: 12 } }, "✕")),
        h("div", { style: { fontSize: 16, fontWeight: 700, marginBottom: 4 } }, pick.label),
        pick.sub && h("div", { style: { fontSize: 10, color: T.muted, marginBottom: 6 } }, pick.sub),
        h("div", { style: { marginBottom: 14 } }, h(ChanceLine, { g })),
        h("div", { style: { fontSize: 8, color: T.muted, letterSpacing: 2, marginBottom: 6 } }, "AMOUNT"),
        h("div", { style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 6 } },
          h("button", { onClick: () => step(-5), style: pill }, "−5"),
          h("input", { type: "number", min: 1, value: usd, onChange: (e) => setUsd(clamp(Math.round(+e.target.value || 0), 0, cap)), style: { ...pill, width: 90, textAlign: "center", fontSize: 18, fontWeight: 700, cursor: "text" } }),
          h("button", { onClick: () => step(5), style: pill }, "+5"),
          usd !== suggested && h("button", { onClick: () => setUsd(Math.min(suggested, cap)), style: { ...pill, fontSize: 10, color: T.muted } }, "suggested " + money(suggested))),
        cap < Infinity && h("div", { style: { fontSize: 9, color: T.dim, marginBottom: 10 } }, `The site's server caps each bet at ${money(cap)}.`),
        h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, background: T.bg, borderRadius: 6, padding: 10, marginBottom: 14, fontSize: 10 } },
          cell("Contracts", t.count + " @ " + pick.price + "¢"), cell("You pay", money(t.cost)), cell("Pays if it wins", money(t.payout), C.STRONG)),
        why && h("div", { style: { fontSize: 10, color: C.SMALL, marginBottom: 10, lineHeight: 1.5 } }, why),
        st.err && h("div", { style: { fontSize: 10, color: C.AVOID, marginBottom: 10, lineHeight: 1.5 } }, st.err),
        h("button", { disabled: !ready || st.busy || t.count < 1, onClick: confirm, style: { width: "100%", padding: 14, borderRadius: 6, border: "none", background: ready && t.count >= 1 ? C.STRONG : T.border, color: ready ? "#04110a" : T.muted, fontSize: 13, fontWeight: 700, letterSpacing: 1, cursor: ready ? "pointer" : "default", fontFamily: "inherit" } },
          st.busy ? "PLACING…" : t.count < 1 ? "AMOUNT TOO SMALL" : `CONFIRM ${money(t.cost)} BET ON KALSHI`),
        h("div", { style: { fontSize: 9, color: T.dim, marginTop: 8, textAlign: "center" } }, "Buys at the current price or not at all. Nothing is left waiting on Kalshi.")));
    function cell(l, v, c) { return h("div", null, h("div", { style: { fontSize: 8, color: T.muted, letterSpacing: 1, marginBottom: 3 } }, l.toUpperCase()), h("div", { style: { fontWeight: 700, color: c || T.text } }, v)); }
  }

  // Sortable header cell: <SortTh k="edge" sort={sort} setSort={setSort}>Edge</SortTh>
  function SortTh({ k, sort, setSort, children, style }) {
    const on = sort.k === k;
    return h("th", { onClick: k ? () => setSort(on ? { k, dir: -sort.dir } : { k, dir: -1 }) : undefined, style: { textAlign: "left", color: on ? T.text : T.muted, fontSize: 8, letterSpacing: 1, padding: "8px 10px", borderBottom: "1px solid " + T.border, textTransform: "uppercase", cursor: k ? "pointer" : "default", whiteSpace: "nowrap", userSelect: "none", ...(style || {}) } },
      children, k ? (on ? (sort.dir < 0 ? " ▼" : " ▲") : " ↕") : "");
  }
  function sortRows(rows, sort, get) { const g = get || ((r, k) => r[k]); return rows.slice().sort((a, b) => { const x = g(a, sort.k), y = g(b, sort.k); return x == null ? 1 : y == null ? -1 : (x > y ? 1 : x < y ? -1 : 0) * sort.dir; }); }

  // Win/loss record of STRONG and GOOD picks for one sport (or all when sport is omitted)
  function RecordCard({ sport }) {
    const [rec, setRec] = useState(null);
    useEffect(() => { readBets().then(b => setRec(record(b))).catch(() => setRec(false)); }, []);
    if (!rec) return null;
    const r = sport ? rec.bySport[sport] : rec.all;
    if (!r || !(r.w + r.l + r.p + r.pending)) return h("div", { style: { background: T.card, border: "1px solid " + T.border, borderRadius: 6, padding: "10px 14px", marginBottom: 12, fontSize: 10, color: T.muted } }, "Record: STRONG and GOOD picks are tracked automatically once they're graded. None settled yet.");
    const line = (k) => h("div", { key: k, style: { display: "flex", gap: 10, alignItems: "center", fontSize: 11 } },
      h("span", { style: { minWidth: 86 } }, h(GradeBadge, { g: { key: k, label: LABEL[k], color: C[k] }, small: true })),
      h("b", null, h("span", { style: { color: C.STRONG } }, r[k].w + "W"), "-", h("span", { style: { color: C.AVOID } }, r[k].l + "L"), r[k].p ? h("span", { style: { color: T.dim } }, " " + r[k].p + "P") : null),
      h("span", { style: { color: T.muted } }, winPct(r[k])), r[k].pending ? h("span", { style: { color: T.dim, fontSize: 9 } }, r[k].pending + " pending") : null);
    return h("div", { style: { background: T.card, border: "1px solid " + T.border, borderRadius: 6, padding: "10px 14px", marginBottom: 12 } },
      h("div", { style: { fontSize: 8, color: T.muted, letterSpacing: 2, marginBottom: 6 } }, "PICK RECORD"), line("STRONG"), line("GOOD"));
  }

  root.SharpBets = Object.assign(api(), { useSettings, useKalshi, GradeBadge, ChanceLine, GradeLegend, BetButton, SortTh, sortRows, RecordCard });

  function api() {
    return { SPORTS, DEFAULTS, COLORS: C, LABELS: LABEL, BLURBS: BLURB, ORDER, getSettings, onSettings, loadSettings, saveSettings, grade, stake, ticket, money,
      kalshiStatus, placeBet, readBets, record, winPct, logPicks, recTier, americanToCents };
  }
  // Sportsbook odds (e.g. -150, +130) to the break-even price in cents, for pages that fall back to sportsbook lines
  function americanToCents(o) { o = parseFloat(String(o).replace(/^~/, "")); if (!isFinite(o) || o === 0) return null; return o < 0 ? 100 * -o / (-o + 100) : 100 * 100 / (o + 100); }
})(typeof window !== "undefined" ? window : globalThis);
if (typeof module !== "undefined") module.exports = globalThis.SharpBets || (typeof window !== "undefined" && window.SharpBets);
