// Refresh golf.html's PLAYER_PARAMS from pgatour.com's free SG: Total stats page (all qualified PGA Tour players).
//   node tools/golf-stats.mjs            -> rewrites the table in golf.html
// sg = season SG:Total per round, shrunk a little toward 0 for players with few measured rounds.
// Players already in the table but missing from this season's list (LIV / DP World Tour, marked est) are kept.
import { readFileSync, writeFileSync } from "node:fs";

const FILE = new URL("../golf.html", import.meta.url);
const html = await (await fetch("https://www.pgatour.com/stats/detail/02675", { headers: { "User-Agent": "Mozilla/5.0" } })).text();
const next = JSON.parse(html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/)[1]);
const q = next.props.pageProps.dehydratedState.queries.map(x => x.state && x.state.data).find(d => d && d.statId === "02675");
if (!q || !q.rows || q.rows.length < 50) throw new Error("couldn't find the SG: Total table");

const src = readFileSync(FILE, "utf8");
const start = src.indexOf("// ── Player Params"), open = src.indexOf("const PLAYER_PARAMS = {", start), close = src.indexOf("\n};", open) + 3;
const old = {};
for (const m of src.slice(open, close).matchAll(/"([^"]+)":\s*\{\s*sg:\s*([-\d.]+),\s*sigma:\s*([\d.]+),\s*abbr:"([^"]*)"(, est:true)?/g))
  old[m[1]] = { sg: +m[2], sigma: +m[3], abbr: m[4], est: !!m[5] };
const norm = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ø/g, "o").toLowerCase();
const oldByNorm = Object.fromEntries(Object.entries(old).map(([k, v]) => [norm(k), { k, ...v }]));

const fresh = q.rows.map(r => {
  const v = Object.fromEntries(r.stats.map(s => [s.statName, parseFloat(String(s.statValue).replace(/,/g, ""))]));
  const n = v["Measured Rounds"] || 0, raw = v["Avg"];
  const sg = raw * n / (n + 5);                                 // light shrink for small samples
  const prev = oldByNorm[norm(r.playerName)];
  const sigma = prev && !prev.est ? prev.sigma : Math.min(3.15, 2.7 + 0.12 * Math.max(0, -sg) + 0.05 * Math.max(0, 1 - sg));
  const last = r.playerName.split(" ").slice(-1)[0].replace(/[^A-Za-z]/g, "");
  return { name: r.playerName, sg, sigma, abbr: (prev && prev.abbr) || last.slice(0, 3).toUpperCase(), n };
});
const have = new Set(fresh.map(f => norm(f.name)));
const kept = Object.entries(old).filter(([k, v]) => v.est && !have.has(norm(k)));

const pad = (s) => (JSON.stringify(s) + ":").padEnd(30);
const f3 = (x) => (x >= 0 ? " " : "") + x.toFixed(3);
const lines = [
  "// ── Player Params ─────────────────────────────────────────────────────────────",
  `// sg: SG:Total per round, ${q.displaySeason} PGA Tour season (${q.lastProcessed}), from pgatour.com; refresh with node tools/golf-stats.mjs`,
  "// est:true = LIV / DP World Tour estimate (no PGA Tour tracked rounds this season)",
  "const PLAYER_PARAMS = {",
  ...fresh.map(f => `  ${pad(f.name)} { sg:${f3(f.sg)}, sigma: ${f.sigma.toFixed(2)}, abbr:"${f.abbr}" },`),
  "  // not on this season's PGA Tour list: kept estimates",
  ...kept.map(([k, v]) => `  ${pad(k)} { sg:${f3(v.sg)}, sigma: ${v.sigma.toFixed(2)}, abbr:"${v.abbr}", est:true },`),
  "};",
];
writeFileSync(FILE, src.slice(0, start) + lines.join("\n") + src.slice(close));
console.log(`${fresh.length} PGA Tour players (${q.lastProcessed}), ${kept.length} kept estimates`);
