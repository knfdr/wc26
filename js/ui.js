// Sharp Sim shared page UI: app shell + nav, page header, pick card, tabs, stat tiles and SVG charts.
// Plain JS (no JSX), loaded after React and js/bets.js:  <script src="js/ui.js"></script>
// Styles are in css/sharp.css. Exposes window.SharpUI.
(function (root) {
  "use strict";
  const R = root.React; if (!R) return;
  const h = R.createElement, { useState, useEffect, useRef, useMemo } = R;
  const SB = root.SharpBets || {};

  // Color with transparency that works for hex and CSS variables alike: alpha("var(--strong)", 15)
  const alpha = (c, pct) => `color-mix(in srgb, ${c} ${pct}%, transparent)`;

  // ── Shell ──────────────────────────────────────────────────────────────────
  const NAV = [
    ["index", "Home", "index.html"],
    ["nfl", "NFL", "nfl.html"],
    ["cfb", "College", "cfb.html"],
    ["golf", "Golf", "golf.html"],
    ["parlays", "Parlays", "parlays.html"],
    ["live", "Live trader", "live.html"],
    ["mlb", "MLB", "mlb.html"],
    ["wnba", "WNBA", "wnba.html"],
  ];
  const gear = h("svg", { width: 20, height: 20, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true" },
    h("circle", { cx: 12, cy: 12, r: 3 }),
    h("path", { d: "M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" }));

  function TopBar({ active }) {
    const navRef = useRef(null);
    useEffect(() => { // keep the current page's pill in view on a phone
      const el = navRef.current && navRef.current.querySelector('[aria-current="page"]');
      if (el && el.scrollIntoView) el.scrollIntoView({ block: "nearest", inline: "center" });
    }, []);
    return h("header", { className: "ss-top" },
      h("div", { className: "ss-top-row" },
        h("a", { href: "index.html", className: "ss-brand", "aria-label": "Sharp Sim home" }, h("span", { className: "ss-mark" }, "S"), "Sharp Sim"),
        h("span", { className: "ss-top-spacer" }),
        h("a", { href: "settings.html", className: "ss-icon-btn", "aria-label": "Settings", "aria-current": active === "settings" ? "page" : undefined }, gear)),
      h("nav", { className: "ss-nav", ref: navRef, "aria-label": "Sports" },
        NAV.map(([k, label, href]) => h("a", { key: k, href, "aria-current": active === k ? "page" : undefined },
          k === "live" ? h("span", { className: "live-dot", "aria-hidden": "true" }) : null, label))));
  }
  function Shell({ active, children, wide }) {
    return h(R.Fragment, null, h(TopBar, { active }), h("main", { className: "ss-main", style: wide ? { maxWidth: 1280 } : null }, children));
  }
  function PageHead({ eyebrow, title, sub, right }) {
    return h("div", { className: "ss-head" },
      h("div", { className: "row", style: { alignItems: "flex-end" } },
        h("div", { style: { flex: 1, minWidth: 0 } },
          eyebrow && h("div", { className: "ss-eyebrow" }, eyebrow),
          h("h1", { className: "ss-h1" }, title)),
        right || null),
      sub && h("p", { className: "ss-sub" }, sub));
  }
  function H2({ children, aside }) { return h("h2", { className: "ss-h2" }, children, aside ? h("span", { className: "aside" }, aside) : null); }
  function Status({ children, spin }) {
    if (!children) return null;
    return h("div", { className: "card status", style: { marginBottom: 12 } }, spin !== false && h("span", { className: "spinner" }), h("span", null, children));
  }
  // tabs: [[key, label, {count, pending}]]
  function Tabs({ tabs, value, onChange }) {
    return h("div", { className: "tabs", role: "tablist" },
      tabs.map(([k, label, o]) => h("button", { key: k, role: "tab", className: "tab", "aria-selected": value === k, onClick: () => onChange(k) },
        label, o && o.count != null ? h("span", { className: "count" }, o.count) : null, o && o.pending ? h("span", { className: "pending", title: "Still simulating" }) : null)));
  }
  function Seg({ options, value, onChange }) {
    return h("div", { className: "seg", role: "group" }, options.map(([k, l]) => h("button", { key: k, "aria-pressed": value === k, onClick: () => onChange(k) }, l)));
  }
  function Tile({ label, value, sub, color }) {
    return h("div", { className: "tile" }, h("div", { className: "l" }, label), h("div", { className: "v num", style: color ? { color } : null }, value), sub ? h("div", { className: "s" }, sub) : null);
  }

  // ── Pick card ──────────────────────────────────────────────────────────────
  // g: grade from SharpBets.grade · title: "BAL -6.5" · meaning: "BAL wins by 7+" · meta: game/time line · pick: BetButton pick
  function PickCard({ g, title, meaning, meta, when, pick, top, children }) {
    const usd = pick && SB.stake ? SB.stake(g, pick.sport, SB.getSettings()) : 0;
    return h("article", { className: "pick" + (top ? " top" : ""), style: { "--g": g ? g.color : "var(--none)" } },
      h("div", { className: "pick-head" },
        top && h("span", { className: "chip", style: { background: alpha("var(--g)", 18), color: "var(--text)" } }, "Best bet"),
        h(SB.GradeBadge, { g }), when ? h("span", { className: "when" }, when) : null),
      h("div", { className: "pick-title" }, title),
      meaning && h("div", { className: "pick-mean" }, meaning),
      h(SB.ChanceBar, { g }),
      children,
      h("div", { className: "pick-foot" },
        h("div", { className: "meta" }, meta, usd ? h("div", null, "Suggested bet ", h("b", null, SB.money(usd))) : null),
        pick && h(SB.BetButton, { pick })));
  }

  // One-line version for the long tail (SMALL EDGE picks): title, compact bar, bet button
  function PickRow({ g, title, meaning, meta, pick, badge, dim, note }) {
    const hl = g && g.rank <= 1;
    return h("div", { className: "pick-row" + (hl ? " hl" : ""), style: { "--g": g ? g.color : "var(--none)", opacity: dim ? 0.55 : 1 } },
      h("div", { className: "pr-main" },
        h("div", { className: "pr-title" }, title, meaning ? h("span", { className: "pr-mean" }, " · " + meaning) : null),
        (meta || badge || note) ? h("div", { className: "pr-meta" }, badge && g ? h(SB.GradeBadge, { g, small: true }) : null, meta ? h("span", null, meta) : null, note ? h("span", null, note) : null) : null),
      g ? h("div", { className: "pr-bar" },
        h("div", { className: "pr-nums" }, h("b", null, Math.round(g.chance) + "%"), h("span", { style: { color: g.edge > 0 ? "var(--g)" : "var(--muted)", fontWeight: 600 } }, (g.edge >= 0 ? "+" : "−") + Math.abs(g.edge).toFixed(1) + "¢"), h("span", { className: "muted" }, Math.round(g.price) + "¢")),
        h(SB.ChanceBar, { g, compact: true })) : h("div", { className: "pr-bar tiny muted" }, "No price"),
      pick ? h(SB.BetButton, { pick, compact: true }) : h("span", { style: { gridArea: "btn" } }));
  }
  function PickList({ children, title }) {
    return h("div", { className: "pick-list" }, title ? h("div", { className: "pl-head" }, title) : null, children);
  }

  // ── Charts ─────────────────────────────────────────────────────────────────
  function useWidth(fallback) {
    const ref = useRef(null);
    const [w, setW] = useState(fallback || 320);
    useEffect(() => {
      const el = ref.current; if (!el) return;
      const set = () => setW(Math.max(200, el.clientWidth || fallback || 320));
      set();
      if (!root.ResizeObserver) return;
      const ro = new ResizeObserver(set); ro.observe(el); return () => ro.disconnect();
    }, []);
    return [ref, w];
  }
  function niceTicks(lo, hi, n) {
    if (!(hi > lo)) { hi = lo + 1; }
    const raw = (hi - lo) / (n || 4), mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw) || raw;
    const out = []; const end = Math.ceil(hi / step - 1e-9) * step; for (let v = Math.floor(lo / step + 1e-9) * step; v <= end + 1e-9; v += step) out.push(+v.toFixed(10));
    return out;
  }
  const roundTop = (x, y, w, hgt, r) => { r = Math.min(r, w / 2, hgt); return `M${x},${y + hgt}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + hgt}Z`; };
  const roundBottom = (x, y, w, hgt, r) => { r = Math.min(r, w / 2, hgt); return `M${x},${y}H${x + w}V${y + hgt - r}Q${x + w},${y + hgt} ${x + w - r},${y + hgt}H${x + r}Q${x},${y + hgt} ${x},${y + hgt - r}Z`; };

  // Line over an index axis. data: [{ y, tip }], color: CSS color. Crosshair + tooltip on hover/touch, value labelled at the end.
  function LineChart({ data, height, color, yFmt, zero, area, endLabel, xLabels, ariaLabel }) {
    const [ref, W] = useWidth();
    const [hi, setHi] = useState(null);
    const H = height || 180, padL = 40, padR = 14, padT = 14, padB = xLabels ? 22 : 10;
    const fmt = yFmt || (v => String(v));
    const ys = data.map(d => d.y);
    let lo = Math.min(...ys, zero ? 0 : Infinity), top = Math.max(...ys, zero ? 0 : -Infinity);
    if (lo === top) { lo -= 1; top += 1; }
    const ticks = niceTicks(lo, top, 4);
    lo = Math.min(lo, ticks[0]); top = Math.max(top, ticks[ticks.length - 1]);
    const n = data.length, iw = W - padL - padR, ih = H - padT - padB;
    const X = (i) => padL + (n <= 1 ? iw / 2 : i / (n - 1) * iw), Y = (v) => padT + (1 - (v - lo) / (top - lo)) * ih;
    const c = color || "var(--series-a)";
    const path = data.map((d, i) => (i ? "L" : "M") + X(i).toFixed(1) + "," + Y(d.y).toFixed(1)).join("");
    const base = Y(zero ? 0 : lo);
    const areaPath = path + `L${X(n - 1).toFixed(1)},${base.toFixed(1)}L${X(0).toFixed(1)},${base.toFixed(1)}Z`;
    function move(e) {
      const r = e.currentTarget.getBoundingClientRect(), px = (e.touches ? e.touches[0].clientX : e.clientX) - r.left;
      setHi(Math.max(0, Math.min(n - 1, Math.round((px - padL) / iw * (n - 1)))));
    }
    const last = data[n - 1];
    return h("div", { className: "chart", ref },
      h("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": ariaLabel || "Line chart", onMouseMove: move, onTouchStart: move, onTouchMove: move, onMouseLeave: () => setHi(null) },
        ticks.map(t => h("g", { key: t },
          h("line", { className: t === 0 && zero ? "axis" : "grid", x1: padL, x2: W - padR, y1: Y(t), y2: Y(t) }),
          h("text", { className: "tick", x: padL - 8, y: Y(t) + 4, textAnchor: "end" }, fmt(t)))),
        xLabels && xLabels.map(([i, l]) => h("text", { key: "x" + i, className: "tick", x: X(i), y: H - 4, textAnchor: i === 0 ? "start" : i === n - 1 ? "end" : "middle" }, l)),
        area !== false && n > 1 && h("path", { d: areaPath, fill: c, opacity: 0.1 }),
        n > 1 && h("path", { d: path, fill: "none", stroke: c, strokeWidth: 2, strokeLinejoin: "round", strokeLinecap: "round" }),
        last && h("circle", { cx: X(n - 1), cy: Y(last.y), r: 4.5, fill: c, stroke: "var(--surface)", strokeWidth: 2 }),
        endLabel !== false && last && h("text", { className: "tick", x: X(n - 1) - 8, y: Y(last.y) - 9, textAnchor: "end", style: { fill: "var(--text)", fontWeight: 600, fontSize: 12 } }, fmt(last.y)),
        hi != null && h("g", null,
          h("line", { x1: X(hi), x2: X(hi), y1: padT, y2: padT + ih, stroke: "var(--axis)", strokeWidth: 1 }),
          h("circle", { cx: X(hi), cy: Y(data[hi].y), r: 5, fill: c, stroke: "var(--surface)", strokeWidth: 2 })),
        h("rect", { x: padL, y: 0, width: iw, height: H, fill: "transparent" })),
      hi != null && h("div", { className: "tip", style: { left: Math.max(70, Math.min(W - 70, X(hi))), top: Y(data[hi].y) } }, data[hi].tip || fmt(data[hi].y)));
  }

  // Columns from one baseline. bars: [{ label, v, color, strong, tip }] · labelOf(i) returns an x label or null
  function BarChart({ bars, height, yFmt, labelOf, ariaLabel, signed }) {
    const [ref, W] = useWidth();
    const [hi, setHi] = useState(null);
    const H = height || 150, padL = signed ? 8 : 34, padR = 6, padT = 10, padB = 22;
    const fmt = yFmt || (v => String(v));
    const vals = bars.map(b => b.v);
    const top = Math.max(...vals, 0), lo = Math.min(...vals, 0);
    const ticks = signed ? [] : niceTicks(0, top, 3);
    const max = signed ? Math.max(top, -lo) || 1 : Math.max(top, ticks[ticks.length - 1] || 1);
    const n = bars.length, iw = W - padL - padR, ih = H - padT - padB, slot = iw / n;
    const bw = Math.max(2, Math.min(24, slot - 2));
    const Y0 = signed ? padT + ih / 2 : padT + ih;
    const scale = signed ? (ih / 2) / max : ih / max;
    return h("div", { className: "chart", ref },
      h("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": ariaLabel || "Bar chart", onMouseLeave: () => setHi(null) },
        ticks.map(t => h("g", { key: t },
          h("line", { className: "grid", x1: padL, x2: W - padR, y1: Y0 - t * scale, y2: Y0 - t * scale }),
          h("text", { className: "tick", x: padL - 6, y: Y0 - t * scale + 4, textAnchor: "end" }, fmt(t)))),
        bars.map((b, i) => {
          const x = padL + i * slot + (slot - bw) / 2, hgt = Math.max(b.v ? 1.5 : 0, Math.abs(b.v) * scale);
          const d = b.v >= 0 ? roundTop(x, Y0 - hgt, bw, hgt, 4) : roundBottom(x, Y0, bw, hgt, 4);
          const lab = labelOf ? labelOf(i, b) : null;
          return h("g", { key: i, onMouseEnter: () => setHi(i), onTouchStart: () => setHi(i) },
            h("rect", { x: padL + i * slot, y: padT, width: slot, height: ih + padB, fill: "transparent" }),
            h("path", { d, fill: b.color || "var(--series-a)", opacity: hi == null || hi === i ? (b.dim ? 0.45 : 1) : 0.35 }),
            lab != null && h("text", { className: "tick", x: x + bw / 2, y: H - 6, textAnchor: "middle", style: b.strong ? { fill: "var(--text)", fontWeight: 600 } : null }, lab));
        }),
        h("line", { className: "axis", x1: padL, x2: W - padR, y1: Y0, y2: Y0 })),
      hi != null && bars[hi] && h("div", { className: "tip", style: { left: Math.max(70, Math.min(W - 70, padL + hi * slot + slot / 2)), top: bars[hi].v >= 0 ? Y0 - Math.abs(bars[hi].v) * scale : Y0 } }, bars[hi].tip || fmt(bars[hi].v)));
  }

  // Nested finish-probability bar (golf): each step contains the next, e.g. make cut ⊃ top 20 ⊃ top 10 ⊃ top 5 ⊃ win.
  // steps: [{ label, p (0-1) }] widest first. One hue, darker for the harder finish.
  function ProbLadder({ steps, color, height }) {
    const c = color || "var(--series-a)", n = steps.length, H = height || 12;
    const label = steps.map(s => `${s.label} ${(s.p * 100).toFixed(s.p < 0.1 ? 1 : 0)}%`).join(", ");
    return h("div", { role: "img", "aria-label": label, title: label, style: { position: "relative", height: H, borderRadius: 999, background: "var(--track)", overflow: "hidden", minWidth: 90 } },
      steps.map((s, i) => h("div", { key: s.label, style: { position: "absolute", left: 0, top: 0, bottom: 0, width: Math.max(0, Math.min(100, s.p * 100)) + "%", background: c, opacity: 0.22 + 0.78 * (i + 1) / n, borderRadius: 999, boxShadow: i ? "2px 0 0 var(--surface)" : "none" } })));
  }

  // Pick record over time: net wins (wins minus losses) or profit if a flat bet went on every pick.
  function RecordChart({ hist, base }) {
    const priced = hist.filter(x => x.price);
    const canMoney = priced.length >= 2;
    const [mode, setMode] = useState("net");
    const amt = base || 20;
    const data = useMemo(() => {
      let acc = 0, w = 0, l = 0;
      const src = mode === "money" ? priced : hist;
      return src.map(x => {
        if (x.win) w++; else l++;
        acc += mode === "money" ? (x.win ? amt * (100 - x.price) / x.price : -amt) : (x.win ? 1 : -1);
        const v = mode === "money" ? Math.round(acc) : acc;
        return { y: v, date: x.date, tip: h(R.Fragment, null, h("b", null, mode === "money" ? (v >= 0 ? "+" : "−") + "$" + Math.abs(v) : (v >= 0 ? "+" : "") + v), ` · ${w}–${l} after ${x.date.slice(5).replace("-", "/")}`) };
      });
    }, [hist, mode, amt]);
    if (data.length < 2) return null;
    const endV = data[data.length - 1].y, col = endV >= 0 ? "var(--pos)" : "var(--neg)";
    const fmtD = (d) => d ? new Date(d + "T12:00").toLocaleDateString([], { month: "short", day: "numeric" }) : "";
    return h("div", null,
      h("div", { className: "row", style: { marginBottom: 6, flexWrap: "wrap" } },
        h("div", { className: "small text-2", style: { flex: 1, minWidth: 160 } }, mode === "money" ? `If you'd bet ${SB.money ? SB.money(amt) : "$" + amt} on every pick` : "Wins minus losses, pick by pick"),
        canMoney && h(Seg, { options: [["net", "Net wins"], ["money", "Profit"]], value: mode, onChange: setMode })),
      h(LineChart, { data, color: col, zero: true, height: 170, ariaLabel: "Pick record over time", yFmt: mode === "money" ? (v => (v < 0 ? "−$" : "$") + Math.abs(v)) : (v => (v > 0 ? "+" : "") + v),
        xLabels: [[0, fmtD(data[0].date)], [data.length - 1, fmtD(data[data.length - 1].date)]] }));
  }

  root.SharpUI = { alpha, NAV, TopBar, Shell, PageHead, H2, Status, Tabs, Seg, Tile, PickCard, PickRow, PickList, LineChart, BarChart, ProbLadder, RecordChart, useWidth, niceTicks };
})(typeof window !== "undefined" ? window : globalThis);
