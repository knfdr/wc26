// Sharp Sim — Football model (college + NFL) + live auto-trader decision engine.
// Games carry g.sport ("cfb" default, or "nfl"); the drive sim, overtime rules and defaults follow the sport.
// Pure functions only (no fetch, no DOM) so the same file runs in the browser
// (window.CFB) and in node tests (require("./js/cfb-engine.js")).
(function (root) {
"use strict";

// ── Parameters ───────────────────────────────────────────────────────────────
const P = {
  SIGMA_MARGIN: 15.0,   // SD of final CFB margin around the closing spread (2026 FBS sample: 14.9)
  SIGMA_TOTAL: 15.2,    // SD of final CFB total around the closing total (2026 sample: 15.2, ~0.29*T)
  HFA: 2.5,             // home-field advantage in points (neutral site = 0)
  GAME_SECONDS: 3600,
  POSS_VAR: 9,          // extra variance (pts^2) from the outcome of the current possession
  AVG_DRIVE_PTS: 1.2,   // average points of a fresh possession (subtracted for totals)
  OT_SD: 7,             // margin SD for an overtime period
};

// ── Math ─────────────────────────────────────────────────────────────────────
function erf(x) {
  // Abramowitz & Stegun 7.1.26 (|err| < 1.5e-7)
  const s = x < 0 ? -1 : 1; x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}
function Phi(z) { return 0.5 * (1 + erf(z / Math.SQRT2)); }
function PhiInv(p) {
  // Acklam's rational approximation
  if (p <= 0) return -8; if (p >= 1) return 8;
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  let q, r;
  if (p < pl) { q = Math.sqrt(-2 * Math.log(p)); return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1); }
  if (p > 1 - pl) { q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1); }
  q = p - 0.5; r = q * q;
  return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q / (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);
}
function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
function median(xs) { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
function weightedMedian(pairs) {
  // pairs: [{v, w}]
  const s = pairs.filter(p => isFinite(p.v) && p.w > 0).sort((a, b) => a.v - b.v);
  if (!s.length) return null;
  const tot = s.reduce((a, p) => a + p.w, 0); let acc = 0;
  for (const p of s) { acc += p.w; if (acc >= tot / 2) return p.v; }
  return s[s.length - 1].v;
}

// ── Expected points of the current possession (from the offense's view) ─────
// Rough CFB EP curve: ~0.4 at own 20, ~2.6 at midfield, ~4.9 at opp 20, ~6 at the goal line.
function expectedPoints(yardsToGoal, down, distance) {
  if (yardsToGoal == null || !isFinite(yardsToGoal)) return P.AVG_DRIVE_PTS;
  let ep = 6.3 - 0.072 * clamp(yardsToGoal, 1, 99);
  if (down >= 2) ep -= 0.3 * (down - 1);
  if (distance > 10) ep -= 0.03 * (distance - 10);
  if (down === 4 && distance > 3 && yardsToGoal > 35) ep = Math.min(ep, 0.0); // punt territory
  return clamp(ep, -0.8, 6.6);
}

// ── ESPN parsing ─────────────────────────────────────────────────────────────
function clockToSeconds(clock) {
  if (!clock) return 0;
  const parts = String(clock).split(":").map(Number);
  return parts.length === 2 ? parts[0] * 60 + parts[1] : (parts[0] || 0);
}

// Parse one ESPN scoreboard event into a compact game object.
function parseEspnEvent(e, sport) {
  const c = e.competitions && e.competitions[0]; if (!c) return null;
  const home = c.competitors.find(x => x.homeAway === "home");
  const away = c.competitors.find(x => x.homeAway === "away");
  if (!home || !away) return null;
  const st = e.status || c.status || {};
  const type = st.type || {};
  const sit = c.situation || {};
  const period = st.period || 0;
  const clockSec = clockToSeconds(st.displayClock);
  let secondsLeft = period === 0 ? P.GAME_SECONDS : period <= 4 ? (4 - period) * 900 + clockSec : 0;
  if (type.state === "post") secondsLeft = 0;
  if (type.name === "STATUS_HALFTIME") secondsLeft = 1800;
  let possession = null;
  if (sit.possession) possession = sit.possession === home.id ? "home" : sit.possession === away.id ? "away" : null;
  const odds = (c.odds || [])[0] || null;
  let spreadHome = null, total = null;
  if (odds) {
    total = odds.overUnder != null ? Number(odds.overUnder) : null;
    // details like "MIA -21" (favorite abbreviation + line) or "EVEN"
    if (odds.details) {
      const m = String(odds.details).match(/^(.+?)\s+(-?[\d.]+)$/);
      if (m) {
        const line = Math.abs(parseFloat(m[2]));
        const fav = m[1].trim();
        const homeIsFav = fav === home.team.abbreviation || fav === home.team.shortDisplayName;
        spreadHome = homeIsFav ? line : -line;      // expected home margin
      } else if (/even|pk|pick/i.test(odds.details)) spreadHome = 0;
    } else if (odds.spread != null) spreadHome = -Number(odds.spread);
  }
  const team = (t) => ({
    id: t.id, abbr: t.team.abbreviation, name: t.team.displayName, short: t.team.shortDisplayName,
    location: t.team.location, mascot: t.team.name, score: Number(t.score || 0),
    rank: t.curatedRank && t.curatedRank.current < 99 ? t.curatedRank.current : null,
    logo: t.team.logo, color: t.team.color ? "#" + t.team.color : null,
    record: (t.records && t.records[0] && t.records[0].summary) || "",
  });
  return {
    sport: sport || "cfb",
    id: e.id, date: e.date, name: e.name, shortName: e.shortName,
    neutral: !!c.neutralSite, venue: c.venue && c.venue.fullName,
    state: type.state, statusName: type.name, detail: type.shortDetail || type.detail,
    period, clock: st.displayClock, clockSec, secondsLeft,
    home: team(home), away: team(away),
    possession, down: sit.down > 0 ? sit.down : null, distance: sit.distance > 0 ? sit.distance : null,
    // ESPN yardLine is measured from the home team's goal line
    yardsToGoal: sit.yardLine > 0 && possession ? (possession === "home" ? 100 - sit.yardLine : sit.yardLine) : null,
    homeTimeouts: sit.homeTimeouts, awayTimeouts: sit.awayTimeouts,
    espnHomeWP: sit.lastPlay && sit.lastPlay.probability ? sit.lastPlay.probability.homeWinPercentage : null,
    isRedZone: !!sit.isRedZone, downDistanceText: sit.downDistanceText || sit.shortDownDistanceText || "",
    lastPlay: sit.lastPlay && sit.lastPlay.text,
    broadcast: (c.broadcasts && c.broadcasts[0] && c.broadcasts[0].names || []).join("/"),
    spreadHome, total,
  };
}

// ── Kalshi live data (Stats Perform feed behind /live_data) ───────────────────
// Overlay a Kalshi live_data.details object onto a parsed ESPN game. `flip` = Kalshi's home is ESPN's away.
// situation.yardline is measured on side_team_id's half of the field.
function applyKalshiLive(g, d, milestone, flip) {
  if (!d || !g) return g;
  const out = { ...g, home: { ...g.home }, away: { ...g.away }, feed: "kalshi" };
  const hp = flip ? d.away_points : d.home_points, ap = flip ? d.home_points : d.away_points;
  if (hp != null) out.home.score = Number(hp);
  if (ap != null) out.away.score = Number(ap);
  const st = String(d.status || "").toLowerCase();
  if (d.quarter) out.period = Number(d.quarter);
  if (d.clock) { out.clock = d.clock; out.clockSec = clockToSeconds(d.clock); }
  if (/halftime/.test(st)) { out.statusName = "STATUS_HALFTIME"; out.secondsLeft = 1800; out.state = "in"; }
  else if (/closed|complete|final/.test(st)) { out.state = "post"; out.secondsLeft = 0; }
  else if (/inprogress|live|in_progress/.test(st)) {
    out.state = "in";
    if (out.statusName === "STATUS_HALFTIME" || out.statusName === "STATUS_SCHEDULED") out.statusName = "STATUS_IN_PROGRESS";
    out.secondsLeft = out.period <= 4 ? (4 - out.period) * 900 + out.clockSec : 0;
  } else if (/delay|suspend/.test(st)) out.statusName = "STATUS_DELAYED";
  const sit = d.situation || {};
  const homeId = milestone && milestone.details ? (flip ? milestone.details.away_team_id : milestone.details.home_team_id) : null;
  const awayId = milestone && milestone.details ? (flip ? milestone.details.home_team_id : milestone.details.away_team_id) : null;
  if (sit.possession_team_id) {
    out.possession = sit.possession_team_id === homeId ? "home" : sit.possession_team_id === awayId ? "away" : out.possession;
    out.down = sit.down || null; out.distance = sit.yfd || null;
    out.yardsToGoal = sit.yardline != null && sit.side_team_id ? (sit.side_team_id === sit.possession_team_id ? 100 - sit.yardline : sit.yardline) : null;
    if (sit.goal_to_go && out.yardsToGoal != null && !out.distance) out.distance = out.yardsToGoal;
  } else if (out.state === "in") { out.possession = null; out.down = null; out.distance = null; out.yardsToGoal = null; }
  out.reviewPending = !!(d.is_under_review || d.result_pending || d.pending_try);
  if (d.last_play && d.last_play.description) out.lastPlay = d.last_play.description;
  out.kalshiUpdatedTs = d.last_updated_ts ? d.last_updated_ts * 1000 : null;
  if (out.down && out.yardsToGoal != null) {
    const ord = ["", "1st", "2nd", "3rd", "4th"][out.down] || out.down + "th";
    out.downDistanceText = `${ord} & ${sit.goal_to_go ? "Goal" : out.distance} · ${out.yardsToGoal} to go${out.possession ? " (" + (out.possession === "home" ? g.home.abbr : g.away.abbr) + ")" : ""}`;
  }
  return out;
}

// ── ESPN core API (sports.core.api.espn.com) — the fastest free feed we found ─────
// c = { status, situation, play } from .../competitions/{id}/status, /situation and the lastPlay $ref.
// situation.yardLine uses the scoreboard convention (measured from the home goal line).
const refId = (r) => { const m = /\/teams\/(\d+)/.exec((r && r.$ref) || ""); return m ? m[1] : null; };
function applyEspnCore(g, c) {
  if (!g || !c) return g;
  const out = { ...g, home: { ...g.home }, away: { ...g.away }, feed: "core" };
  const pl = c.play;
  // Plays can carry odd scores (an "Extra Point Good" play once read 7-1 while the game was 7-7), so core may raise a
  // team's score but never drop it below the scoreboard's; a real reversal shows up when the scoreboard drops too.
  if (pl && pl.homeScore != null && pl.awayScore != null) {
    out.home.score = Math.max(Number(g.home.score) || 0, Number(pl.homeScore));
    out.away.score = Math.max(Number(g.away.score) || 0, Number(pl.awayScore));
  }
  const s = c.status;
  if (s) {
    const tn = (s.type && s.type.name) || out.statusName, ts = (s.type && s.type.state) || out.state;
    out.statusName = tn; out.state = ts;
    if (s.period) out.period = Number(s.period);
    if (s.displayClock) { out.clock = s.displayClock; out.clockSec = clockToSeconds(s.displayClock); }
    if (tn === "STATUS_HALFTIME") out.secondsLeft = 1800;
    else if (ts === "post") out.secondsLeft = 0;
    else if (ts === "in") out.secondsLeft = out.period <= 4 ? (4 - out.period) * 900 + out.clockSec : 0;
  }
  const sit = c.situation;
  if (sit && out.state === "in") {
    const pid = refId(sit.team);
    out.possession = pid && pid === String(g.home.id) ? "home" : pid && pid === String(g.away.id) ? "away" : null;
    const live = out.possession && sit.down > 0;
    out.down = live ? sit.down : null; out.distance = live ? sit.distance : null;
    out.yardsToGoal = out.possession && sit.yardLine != null ? (out.possession === "home" ? 100 - sit.yardLine : sit.yardLine) : null;
    out.redZone = !!sit.isRedZone;
    if (live && out.yardsToGoal != null) {
      const ord = ["", "1st", "2nd", "3rd", "4th"][out.down] || out.down + "th";
      out.downDistanceText = `${ord} & ${out.distance >= out.yardsToGoal ? "Goal" : out.distance} · ${out.yardsToGoal} to go (${out.possession === "home" ? g.home.abbr : g.away.abbr})`;
    } else out.downDistanceText = null;
  }
  if (pl && pl.text) out.lastPlay = pl.text;
  if (pl && pl.wallclock) { const w = Date.parse(pl.wallclock); if (isFinite(w)) out.playWallclock = w; }   // real-world time of the play
  return out;
}

// Game progress, for picking whichever feed is furthest along: score first, then elapsed time.
function feedProgress(g) {
  if (!g) return -1;
  const sum = (g.home.score || 0) + (g.away.score || 0);
  const elapsed = g.state === "post" ? 9999 : g.statusName === "STATUS_HALFTIME" ? 1800 : (g.period || 0) * 900 - (g.clockSec != null ? g.clockSec : 900);
  return sum * 10000 + Math.max(0, elapsed);
}

// ── Live projection ──────────────────────────────────────────────────────────
// pre = { spreadHome (expected home margin, full game), total }
function liveProjection(g, pre) {
  const margin = g.home.score - g.away.score;
  const current = g.home.score + g.away.score;
  const spread = pre && isFinite(pre.spreadHome) ? pre.spreadHome : 0;
  const tot = pre && isFinite(pre.total) ? pre.total : 55;
  if (g.state === "post") return { tau: 0, meanMargin: margin, sdMargin: 0.01, meanTotal: current, sdTotal: 0.01, final: true };
  if (g.period > 4 || (g.period === 4 && g.secondsLeft === 0 && margin === 0)) {
    // overtime: alternate possessions; roughly a coin flip around a small edge
    return { tau: 0.05, meanMargin: margin + spread * 0.04, sdMargin: P.OT_SD, meanTotal: current + 7, sdTotal: 6, ot: true };
  }
  const tau = clamp(g.secondsLeft / P.GAME_SECONDS, 0, 1);
  const hasPoss = g.state === "in" && g.possession && g.statusName !== "STATUS_HALFTIME";
  const ep = hasPoss ? expectedPoints(g.yardsToGoal, g.down, g.distance) : 0;
  const epSigned = g.possession === "home" ? ep : g.possession === "away" ? -ep : 0;
  // possession value matters most late; early its value is mostly absorbed in the rate
  const possWeight = hasPoss ? clamp(1 - tau * 0.6, 0.4, 1) : 0;
  const meanMargin = margin + spread * tau + epSigned * possWeight;
  const sdMargin = Math.sqrt(P.SIGMA_MARGIN ** 2 * tau + (hasPoss ? P.POSS_VAR : 0) + 0.25);
  const elapsed = 1 - tau;
  const obsRate = elapsed > 0.12 ? current / elapsed : tot;
  const w = clamp(elapsed * 0.5, 0, 0.4);           // trust observed pace up to 40%
  const rate = (1 - w) * tot + w * obsRate;
  const meanTotal = current + rate * tau + (hasPoss ? (ep - P.AVG_DRIVE_PTS) * possWeight : 0);
  const sdTotal = Math.sqrt(P.SIGMA_TOTAL ** 2 * tau + (hasPoss ? P.POSS_VAR : 0) + 0.25);
  return { tau, meanMargin, sdMargin, meanTotal, sdTotal, ep: epSigned };
}

// Probability helpers on a projection.
function pHomeWin(pr) { return pr.final ? (pr.meanMargin > 0 ? 1 : 0) : Phi(pr.meanMargin / pr.sdMargin); }
function pCover(pr, side, line) {
  // side "home" wins by more than line
  const m = side === "home" ? pr.meanMargin : -pr.meanMargin;
  if (pr.final) return m > line ? 1 : 0;
  return Phi((m - line) / pr.sdMargin);
}
function pOver(pr, line) { return pr.final ? (pr.meanTotal > line ? 1 : 0) : Phi((pr.meanTotal - line) / pr.sdTotal); }

// ── Drive-level Monte Carlo of the rest of the game ─────────────────────────
// Football scores come in 3s and 7s, so late in games a normal curve badly misprices
// strikes near the current margin. This simulates the remaining possessions instead.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const DRIVES_PER_TEAM = 12;    // CFB FBS average possessions per team per game
const DRIVE_SECS = 150;        // average possession length (3600 / 24)
const LEAGUE_DRIVE_PTS = 2.25; // league average points per possession
// Per-sport drive-sim settings. NFL: the clock runs after first downs (~10.8 drives a team), kickoffs come out to the
// 35 (drives start ~own 30), kickers make ~57-yarders, and OT is a 10-minute period where both teams get the ball.
const SPORTS = {
  cfb: { drivesPerTeam: DRIVES_PER_TEAM, driveSecs: DRIVE_SECS, leagueDrivePts: LEAGUE_DRIVE_PTS, freshYtg: 72, defaultTotal: 55, sigmaMargin: 15.0, ot: "cfb" },
  nfl: { drivesPerTeam: 10.8, driveSecs: 167, leagueDrivePts: 2.06, freshYtg: 70, defaultTotal: 44, sigmaMargin: 13.2, ot: "nfl" },
};
const sportOf = (g) => SPORTS[(g && g.sport) || "cfb"] || SPORTS.cfb;
// NFL drive outcomes (2023-25): ~22.5% TD and ~16.5% FG from the own 30; FG range to about the 40 (57 yards).
function driveProbsNfl(ytg, down, dist, strength) {
  const y = ytg == null ? 70 : clamp(ytg, 1, 99);
  let pTD = 0.225 + (70 - y) * 0.0058;
  let pFG = y <= 25 ? 0.38 : y <= 40 ? 0.29 : y <= 55 ? 0.21 : 0.165;
  if (down === 3) { const d = dist || 7; pTD *= d <= 2 ? 0.95 : d <= 6 ? 0.8 : d <= 10 ? 0.65 : 0.5; }
  if (down === 4) {
    if (y > 40 && (dist || 10) > 2) { pTD *= 0.12; pFG = y <= 42 ? 0.45 : 0; }                         // punt / very long FG
    else if (y <= 40 && (dist || 10) > 3) { pTD *= 0.3; pFG = y <= 25 ? 0.9 : y <= 33 ? 0.82 : 0.68; }  // FG attempt
    else pTD *= 0.75;                                                                                  // go for it
  }
  const k = Math.pow(clamp(strength, 0.3, 2.5), 0.85);
  pTD = clamp(pTD * k, 0.01, 0.85); pFG = clamp(pFG * Math.pow(k, 0.4), 0, 0.92 - pTD);
  return { pTD, pFG };
}
const driveProbsFor = (S) => S.ot === "nfl" ? driveProbsNfl : driveProbs;

// Probabilities of TD / FG for a possession, given field position and the offense's strength.
function driveProbs(ytg, down, dist, strength) {
  // strength = team pts per drive / league avg
  const y = ytg == null ? 72 : clamp(ytg, 1, 99);
  let pTD = 0.235 + (75 - y) * 0.0055;
  let pFG = y <= 35 ? 0.30 : y <= 55 ? 0.19 : 0.12;
  if (down === 3) { pTD *= distance3(dist); }
  if (down === 4) {
    if (y > 38 && (dist || 10) > 2) { pTD *= 0.12; pFG = y <= 40 ? 0.35 : 0; }      // punt / long FG
    else if (y <= 38 && (dist || 10) > 3) { pTD *= 0.35; pFG = 0.6; }              // FG attempt
    else { pTD *= 0.75; }
  }
  const k = Math.pow(clamp(strength, 0.3, 2.5), 0.85);
  pTD = clamp(pTD * k, 0.01, 0.85); pFG = clamp(pFG * Math.pow(k, 0.4), 0, 0.9 - pTD);
  return { pTD, pFG };
  function distance3(d) { d = d || 7; return d <= 2 ? 0.95 : d <= 6 ? 0.8 : d <= 10 ? 0.65 : 0.5; }
}

// Simulate the rest of game g. homePts/awayPts = expected full-game points for each team.
// delta shifts strength toward home (e^delta / e^-delta); kappa scales both offenses.
function simRemaining(g, homePts, awayPts, n, opts) {
  opts = opts || {};
  const delta = opts.delta || 0, kappa = opts.kappa || 1;
  const rnd = mulberry32(opts.seed || 12345);
  const margins = new Int16Array(n), totals = new Int16Array(n);
  const S = sportOf(g), DP = driveProbsFor(S), nfl = S.ot === "nfl";
  const sH = Math.max(0.2, homePts / S.drivesPerTeam / S.leagueDrivePts * Math.exp(delta) * kappa);
  const sA = Math.max(0.2, awayPts / S.drivesPerTeam / S.leagueDrivePts * Math.exp(-delta) * kappa);
  const fresh = { H: DP(S.freshYtg, 1, 10, sH), A: DP(S.freshYtg, 1, 10, sA) };
  const ot = g.period > 4 || (g.period === 4 && g.secondsLeft === 0 && g.home.score === g.away.score);
  const otProbs = nfl ? fresh : { H: driveProbs(25, 1, 10, sH), A: driveProbs(25, 1, 10, sA) };
  const playoff = !!opts.playoff;
  const halftime = g.statusName === "STATUS_HALFTIME";
  for (let i = 0; i < n; i++) {
    let h = g.home.score, a = g.away.score;
    if (g.state === "post") { margins[i] = h - a; totals[i] = h + a; continue; }
    let t = ot ? 0 : g.secondsLeft;
    let poss = g.possession === "home" ? "H" : g.possession === "away" ? "A" : (rnd() < 0.5 ? "H" : "A");
    let first = !halftime && !!g.possession && g.state === "in";
    while (t > 0) {
      const lead = poss === "H" ? h - a : a - h;
      // leading team with the ball late just runs the clock out
      if (lead > 0 && t <= (nfl ? 130 : 110) && rnd() < (nfl ? 0.88 : 0.85)) break;   // NFL: two-minute warning + one first down
      const pr = first ? DP(g.yardsToGoal, g.down, g.distance, poss === "H" ? sH : sA) : fresh[poss];
      // clock management: trailing team hurries late; leading team grinds in the 4th quarter
      const hurry = lead < 0 && t < 480;
      const grind = lead > 0 && t < 900 ? 1.4 : 1;
      const dt = first ? S.driveSecs * 0.45 * (0.3 + rnd()) * grind : (hurry ? 95 : S.driveSecs * grind) * (0.4 + 1.2 * rnd());
      const u = rnd();
      let pts = 0, def = 0;
      // NFL end-game play-calling: inside 5 minutes a team down 1-3 (or tied) plays for the field goal, a team down 4-8
      // needs the touchdown, and two-point tries follow the chart. This is what piles final margins onto 3 and 7.
      let pTD = pr.pTD, pFG = pr.pFG;
      if (nfl && t < 300) {
        if (lead < 0 && lead >= -3) { pFG = Math.min(0.62, pFG * 2.4); pTD *= 0.8; }
        else if (lead === 0 && t < 200) { pFG = Math.min(0.55, pFG * 2.0); pTD *= 0.85; }
        else if (lead <= -4 && lead >= -8) { pTD = Math.min(0.62, pTD * 1.45); pFG = 0.02; }
        else if (lead > 0) { pTD *= 0.85; pFG *= 1.2; }   // leading: run the ball, take the points
        if (t < 90) { pTD *= Math.max(0.25, t / 90); pFG *= Math.max(0.4, t / 90); }   // not much time left to move the ball
      }
      if (u < pTD) {
        const x = rnd();
        if (nfl) { const after = lead + 6; const goFor2 = after === -2 || (t < 600 && (after === -5 || after === 1 || after === -10));
                   pts = goFor2 ? (x < 0.48 ? 8 : 6) : x < 0.95 ? 7 : 6; }
        else pts = x < 0.93 ? 7 : x < 0.97 ? 6 : 8;
      }
      else if (u < pTD + pFG) pts = 3;
      else { const x = rnd(); if (x < 0.018) def = 7; else if (x < 0.023) def = 2; }
      // a drive can't take longer than the time left; a score on the final drive still counts
      if (poss === "H") { h += pts; a += def; } else { a += pts; h += def; }
      t -= dt; first = false; poss = poss === "H" ? "A" : "H";
    }
    if (h === a && nfl) {
      // NFL OT (2025 rules): both teams get a possession, then sudden death in a 10-minute period; ties stand in the regular season
      const drive = (side, mode) => {   // mode: "any" | "need-td" (down 6-8: four-down territory, TD or bust)
        const pr = otProbs[side], u = rnd();
        if (mode === "need-td") return u < Math.min(0.85, pr.pTD * 1.35) ? (rnd() < 0.6 ? 7 : 8) : 0;
        return u < pr.pTD ? 7 : u < pr.pTD + pr.pFG ? 3 : 0;
      };
      const f = rnd() < 0.5 ? "H" : "A", sec = f === "H" ? "A" : "H";
      const p1 = drive(f, "any"); if (f === "H") h += p1; else a += p1;
      const p2 = drive(sec, p1 >= 6 ? "need-td" : "any"); if (sec === "H") h += p2; else a += p2;
      let side = f, left = playoff ? 99 : (() => { const r = rnd(); return r < 0.2 ? 1 : r < 0.65 ? 2 : 3; })();   // possessions left in the period after the first two
      while (h === a && left-- > 0) { const pts = drive(side, "any"); if (side === "H") h += pts; else a += pts; side = side === "H" ? "A" : "H"; }
      margins[i] = h - a; totals[i] = h + a; continue;
    }
    if (h === a) { // overtime: alternate possessions from the 25 until someone leads after a round
      let round = 0;
      while (h === a && round < 8) {
        round++;
        for (const side of ["H", "A"]) {
          const pr = otProbs[side]; const u = rnd();
          const pts = round >= 3 ? (rnd() < 0.45 * (side === "H" ? sH : sA) ** 0.3 ? 2 : 0)
                    : u < pr.pTD ? (round === 2 ? (rnd() < 0.5 ? 8 : 6) + 0 : 7) : u < pr.pTD + pr.pFG ? 3 : 0;
          if (side === "H") h += pts; else a += pts;
        }
      }
      if (h === a) { if (rnd() < 0.5) h += 2; else a += 2; }
    }
    margins[i] = h - a; totals[i] = h + a;
  }
  return makeDist(margins, totals);
}
function makeDist(margins, totals) {
  const n = margins.length;
  let hw = 0, sm = 0, st = 0; for (let i = 0; i < n; i++) { if (margins[i] > 0) hw++; sm += margins[i]; st += totals[i]; }
  // cumulative tables so each probability lookup is O(1): gtM[x+OFF] = #margins > x, gtT[x] = #totals > x
  const OFF = 400, gtM = new Int32Array(2 * OFF + 2), gtT = new Int32Array(OFF + 2);
  const cm = new Int32Array(2 * OFF + 2), ct = new Int32Array(OFF + 2);
  for (let i = 0; i < n; i++) { cm[clamp(margins[i], -OFF, OFF) + OFF]++; ct[clamp(totals[i], 0, OFF)]++; }
  for (let x = 2 * OFF; x >= 0; x--) gtM[x] = gtM[x + 1] + cm[x + 1];
  for (let x = OFF; x >= 0; x--) gtT[x] = gtT[x + 1] + ct[x + 1];
  const gtMargin = (L) => { const x = Math.floor(L); if (x < -OFF) return n; if (x > OFF) return 0; return gtM[x + OFF]; };   // #margins > L
  const ltMargin = (L) => { const x = Math.ceil(L) - 1; return n - gtMargin(x); };                                          // #margins < L
  return { n, margins, totals, pHome: hw / n, meanMargin: sm / n, meanTotal: st / n,
    pCover(side, line) { return (side === "home" ? gtMargin(line) : ltMargin(-line)) / n; },
    pOver(line) { const x = Math.floor(line); if (x < 0) return 1; if (x > OFF) return 0; return gtT[x] / n; } };
}

// Points per team implied by a spread (expected home margin) and total.
function teamPoints(pre, sport) {
  const s = pre && isFinite(pre.spreadHome) ? pre.spreadHome : 0;
  const t = pre && isFinite(pre.total) ? pre.total : (SPORTS[sport] || SPORTS.cfb).defaultTotal;
  return { home: Math.max(3, (t + s) / 2), away: Math.max(3, (t - s) / 2) };
}

// Calibrate (delta, kappa) so the sim reproduces the market's own liquid prices:
//   delta (strength tilt) matches the moneyline; kappa (scoring rate) matches the total strike
//   nearest 50%. Then blend probabilities: alpha * our pregame-anchored sim + (1-alpha) * calibrated sim.
const _calCache = new Map(), _lastCal = new Map();
function liveDistribution(g, pre, markets, cfg) {
  cfg = cfg || {};
  const alpha = cfg.alpha != null ? cfg.alpha : 0.35;
  const tp = teamPoints(pre, g.sport);
  const N_CAL = 1500, N = cfg.sims || 8000;
  const seed = 987654;
  const ot = g.period > 4 || (g.period === 4 && g.secondsLeft === 0 && g.home.score === g.away.score);
  const target = { pHome: null, totalLine: null, pOver: null };
  if (g.state === "in" || g.state === "pre") {
    const maxW = cfg.maxQuoteWidth || 6;
    const live = (markets || []).filter(mk => !mk.half && mk.status === "active" && mid(mk) != null && mk.yesAsk - mk.yesBid <= maxW);
    const win = live.filter(mk => mk.kind === "win");
    if (win.length) {
      const ps = win.map(mk => mk.side === "home" ? mid(mk) / 100 : 1 - mid(mk) / 100);
      const p = ps.reduce((x, y) => x + y, 0) / ps.length;
      if (p > 0.03 && p < 0.97) target.pHome = p;
    }
    let bestT = null;
    for (const mk of live.filter(mk => mk.kind === "total")) {
      const p = mid(mk) / 100; if (p < 0.12 || p > 0.88) continue;
      const score = Math.abs(p - 0.5) - Math.log(1 + mk.volume) * 0.005;
      if (!bestT || score < bestT.score) bestT = { score, line: mk.line, p };
    }
    if (bestT) { target.totalLine = bestT.line; target.pOver = bestT.p; }
  }
  const sig = [g.id, g.home.score, g.away.score, g.period, Math.round(g.secondsLeft / 15), g.possession, g.yardsToGoal, g.down,
               target.pHome && target.pHome.toFixed(2), target.totalLine, target.pOver && target.pOver.toFixed(2), tp.home, tp.away, alpha].join("|");
  const finish = (o) => {
    const corr = o.heldCorr !== undefined ? o.heldCorr : cfg.ladderCorrection === false ? null : ladderCorrection(o.mixed, g, markets, cfg.maxQuoteWidth || 6);
    const dist = applyCorrection(o.mixed, corr);
    dist.unreliable = o.mixed.unreliable; dist.calibratedTo = o.target;
    return { ...o, dist, corr };
  };
  if (cfg.hold && cfg.hold.cal) {
    // feed-lead mode: keep the calibration fitted before the latest score/possession change, apply it to the new state
    const ck = "hold|" + sig + "|" + cfg.hold.cal.delta.toFixed(3) + "|" + cfg.hold.cal.kappa.toFixed(3);
    const h = _calCache.get(g.id + "#hold");
    if (h && h.sig === ck) return finish(h.out);
    const calibrated = simRemaining(g, tp.home, tp.away, N, { ...cfg.hold.cal, seed: seed + 1 });
    const model = alpha > 0 ? simRemaining(g, tp.home, tp.away, N, { delta: 0, kappa: 1, seed: seed + 2 }) : calibrated;
    const mixed = mixDist(model, calibrated, alpha); mixed.unreliable = ot;
    const out = { mixed, cal: cfg.hold.cal, eff: cfg.hold.cal, target, tp, model, calibrated, held: true, heldCorr: cfg.hold.corr || null };
    _calCache.set(g.id + "#hold", { sig: ck, out });
    return finish(out);
  }
  const hit = _calCache.get(g.id);
  if (hit && hit.sig === sig) return finish(hit.out);

  const cal = { delta: 0, kappa: 1 };
  if (!ot && g.state !== "post") {
    // warm start from this game's last calibration: a narrow bracket and one round is enough between ticks
    const prev = _lastCal.get(g.id);
    const bisect = (lo, hi, iters, f) => { for (let it = 0; it < iters; it++) { const m = (lo + hi) / 2; if (f(m)) lo = m; else hi = m; } return (lo + hi) / 2; };
    const fitDelta = (lo, hi, iters) => bisect(lo, hi, iters, m => simRemaining(g, tp.home, tp.away, N_CAL, { delta: m, kappa: cal.kappa, seed }).pHome < target.pHome);
    const fitKappa = (lo, hi, iters) => bisect(lo, hi, iters, m => simRemaining(g, tp.home, tp.away, N_CAL, { delta: cal.delta, kappa: m, seed }).pOver(target.totalLine) < target.pOver);
    const edge = (v, lo, hi) => Math.abs(v - lo) < 0.02 * (hi - lo) || Math.abs(v - hi) < 0.02 * (hi - lo);
    if (prev) {
      cal.delta = prev.delta; cal.kappa = prev.kappa;
      if (target.pHome != null) { const lo = prev.delta - 0.4, hi = prev.delta + 0.4; cal.delta = fitDelta(lo, hi, 6); if (edge(cal.delta, lo, hi)) cal.delta = fitDelta(-2.5, 2.5, 10); }
      if (target.totalLine != null) { const lo = prev.kappa * 0.8, hi = prev.kappa * 1.25; cal.kappa = fitKappa(lo, hi, 6); if (edge(cal.kappa, lo, hi)) cal.kappa = fitKappa(0.25, 3, 9); }
    } else {
      for (let round = 0; round < (target.pHome != null && target.totalLine != null ? 2 : 1); round++) {
        if (target.pHome != null) cal.delta = fitDelta(-2.5, 2.5, 10);
        if (target.totalLine != null) cal.kappa = fitKappa(0.25, 3, 9);
      }
    }
    _lastCal.set(g.id, { delta: cal.delta, kappa: cal.kappa });
  }
  const calibrated = simRemaining(g, tp.home, tp.away, N, { ...cal, seed: seed + 1 });
  const model = alpha > 0 ? simRemaining(g, tp.home, tp.away, N, { delta: 0, kappa: 1, seed: seed + 2 }) : calibrated;
  const mixed = mixDist(model, calibrated, alpha);
  // overtime state (which possession of the round) isn't modeled: don't trust fair values there
  mixed.unreliable = ot;
  const out = { mixed, cal, eff: cal, target, tp, model, calibrated };
  _calCache.set(g.id, { sig, out });
  return finish(out);
}
// Ladder correction: the drive sim gets the moneyline and one total strike right, but its tails don't match the
// market's spread/total ladders (it consistently under-priced big favourite covers). Fit a smooth probit-space
// correction r(T) = a + b·(T − Tc) to each liquid ladder and apply it to every strike.
function fitCorrection(points) {
  const pts = points.filter(q => q.w > 0);
  if (!pts.length) return null;
  let W = 0, ST = 0, SR = 0; for (const q of pts) { W += q.w; ST += q.w * q.T; SR += q.w * q.r; }
  const Tc = ST / W, a = SR / W;
  let Stt = 0, Str = 0; for (const q of pts) { Stt += q.w * (q.T - Tc) ** 2; Str += q.w * (q.T - Tc) * (q.r - a); }
  const b = Stt / W > 4 ? clamp(Str / Stt, -0.06, 0.06) : 0;
  return { a: clamp(a, -0.6, 0.6), b, Tc, n: pts.length };
}
function ladderCorrection(dist, g, markets, maxW) {
  const zc = (p) => PhiInv(clamp(p, 0.005, 0.995));
  const M = [], Tt = [];
  for (const mk of markets || []) {
    if (mk.half || mk.status !== "active" || mk.yesBid == null || mk.yesAsk == null || mk.yesAsk - mk.yesBid > maxW) continue;
    const md = (mk.yesBid + mk.yesAsk) / 200; if (md < 0.08 || md > 0.92) continue;
    const w = 1 / (1 + mk.yesAsk - mk.yesBid);
    if (mk.kind === "spread" || mk.kind === "win") {
      const L = mk.kind === "win" ? 0 : mk.line;
      const T = mk.side === "home" ? L : -L, pm = mk.side === "home" ? md : 1 - md;   // P(home margin > T)
      M.push({ T, w, r: zc(pm) - zc(dist.pCover("home", T)) });
    } else if (mk.kind === "total") Tt.push({ T: mk.line, w, r: zc(md) - zc(dist.pOver(mk.line)) });
  }
  return { margin: fitCorrection(M), total: fitCorrection(Tt) };
}
function applyCorrection(dist, corr) {
  if (!corr || (!corr.margin && !corr.total)) return dist;
  const adj = (c, p, T) => c ? Phi(PhiInv(clamp(p, 0.0005, 0.9995)) + c.a + c.b * (T - c.Tc)) : p;
  const hm = (T) => adj(corr.margin, dist.pCover("home", T), T);
  return { ...dist, corrected: corr,
    pHome: hm(0),
    pCover: (side, line) => side === "home" ? hm(line) : 1 - hm(-line),
    pOver: (line) => adj(corr.total, dist.pOver(line), line) };
}

function mixDist(a, b, alpha) {
  if (a === b || alpha <= 0) return b;
  const w = alpha;
  return { n: b.n, margins: b.margins, totals: b.totals, mixed: true,
    pHome: w * a.pHome + (1 - w) * b.pHome,
    meanMargin: w * a.meanMargin + (1 - w) * b.meanMargin, meanTotal: w * a.meanTotal + (1 - w) * b.meanTotal,
    pCover: (side, line) => w * a.pCover(side, line) + (1 - w) * b.pCover(side, line),
    pOver: (line) => w * a.pOver(line) + (1 - w) * b.pOver(line) };
}

// ── Pregame Monte Carlo (correlated margin/total) ───────────────────────────
function pregameSim(spreadHome, total, n) {
  n = n || 100000;
  // favourite-signed margin error and total error correlate ~+0.15 (favourite covers -> over)
  const rho = 0.15 * (spreadHome >= 0 ? 1 : -1);
  const sigT = clamp(0.29 * total, 11, 19);
  let homeWin = 0;
  const margins = new Float32Array(n), totals = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let u = 0, v = 0; while (u === 0) u = Math.random(); while (v === 0) v = Math.random();
    const r = Math.sqrt(-2 * Math.log(u));
    const z1 = r * Math.cos(2 * Math.PI * v), z2 = r * Math.sin(2 * Math.PI * v);
    let m = spreadHome + P.SIGMA_MARGIN * z1;
    const t = total + sigT * (rho * z1 + Math.sqrt(1 - rho * rho) * z2);
    m = Math.round(m); if (m === 0) m = Math.random() < 0.5 + spreadHome * 0.01 ? 1 : -1; // OT
    margins[i] = m; totals[i] = Math.max(0, Math.round(t));
    if (m > 0) homeWin++;
  }
  return { n, margins, totals, pHome: homeWin / n,
    pCover(side, line) { let k = 0; for (let i = 0; i < n; i++) { const m = side === "home" ? margins[i] : -margins[i]; if (m > line) k++; } return k / n; },
    pOver(line) { let k = 0; for (let i = 0; i < n; i++) if (totals[i] > line) k++; return k / n; },
  };
}

// Pregame drive-level Monte Carlo: tilt (delta) and scoring rate (kappa) are fitted so the median margin sits on the
// spread and the median total on the total (half a push counted on each side), then n full games are simulated.
// Margins land on 3, 7, 10, 14... the way real football scores do, which a normal curve can't reproduce.
function pregameDriveSim(spreadHome, total, n, sport, opts) {
  opts = opts || {};
  n = n || 100000;
  const g0 = { id: "pre", sport: sport || "nfl", state: "pre", statusName: "STATUS_SCHEDULED", period: 0, secondsLeft: 3600, clockSec: 900,
    home: { score: 0 }, away: { score: 0 }, possession: null };
  const tp = teamPoints({ spreadHome, total }, g0.sport);
  const N = opts.calSims || 6000, seed = opts.seed || 4242;
  const medGap = (d, L, kind) => kind === "m" ? d.pCover("home", L) + 0.5 * (d.pCover("home", L - 1) - d.pCover("home", L)) * (L % 1 === 0 ? 1 : 0)
                                            : d.pOver(L) + 0.5 * (d.pOver(L - 1) - d.pOver(L)) * (L % 1 === 0 ? 1 : 0);
  const bisect = (lo, hi, iters, f) => { for (let it = 0; it < iters; it++) { const m = (lo + hi) / 2; if (f(m)) lo = m; else hi = m; } return (lo + hi) / 2; };
  let delta = 0, kappa = 1;
  for (let round = 0; round < 2; round++) {
    delta = bisect(-2, 2, 13, m => medGap(simRemaining(g0, tp.home, tp.away, N, { delta: m, kappa, seed }), spreadHome, "m") < 0.5);
    kappa = bisect(0.4, 2.5, 12, m => medGap(simRemaining(g0, tp.home, tp.away, N, { delta, kappa: m, seed }), total, "t") < 0.5);
  }
  const dist = simRemaining(g0, tp.home, tp.away, n, { delta, kappa, seed: seed + 7, playoff: opts.playoff });
  let sm = 0, sm2 = 0, st = 0, st2 = 0, ties = 0;
  for (let i = 0; i < dist.n; i++) { const m = dist.margins[i], t = dist.totals[i]; sm += m; sm2 += m * m; st += t; st2 += t * t; if (m === 0) ties++; }
  dist.sdMargin = Math.sqrt(sm2 / dist.n - (sm / dist.n) ** 2); dist.sdTotal = Math.sqrt(st2 / dist.n - (st / dist.n) ** 2);
  dist.pTie = ties / dist.n; dist.pAway = 1 - dist.pHome - dist.pTie; dist.cal = { delta, kappa };
  // how often each final margin happens (home perspective), for the key-number view
  dist.marginFreq = (x) => { let k = 0; for (let i = 0; i < dist.n; i++) if (dist.margins[i] === x) k++; return k / dist.n; };
  // NFL shape correction: independent drives let underdogs come back too often (a 7.5-point favourite wins ~76%
  // historically; the raw sim says ~70%). Shift the margin curve in probit space between a 0 margin and the spread so
  // P(win) matches the long-run spread-to-moneyline table while the median stays on the line.
  if (g0.sport === "nfl" && Math.abs(spreadHome) >= 1.5 && opts.shape !== false) {
    const fav = Math.abs(spreadHome), pT = nflFavWinPct(fav);
    const pSim = spreadHome > 0 ? dist.pCover("home", 0) : dist.pCover("away", 0);
    const zc = (p) => PhiInv(clamp(p, 0.005, 0.995));
    // shift (in probit space, home view) is full on the underdog side of 0, fades to nothing at the spread, and is zero
    // beyond it, so blowout and key-number tails are left as the sim drew them
    const D = (zc(pT) - zc(pSim)) * (spreadHome > 0 ? 1 : -1);
    const w = (T) => spreadHome > 0 ? (T <= 0 ? 1 : T >= spreadHome ? 0 : 1 - T / spreadHome) : (T >= 0 ? 1 : T <= spreadHome ? 0 : 1 - T / spreadHome);
    const hm = (T) => { const p = dist.pCover("home", T), k = w(T); return k ? Phi(PhiInv(clamp(p, 0.0005, 0.9995)) + D * k) : p; };
    const corr = { margin: { kind: "nfl-shape", D, spread: spreadHome }, total: null };
    const out = { ...dist, corrected: corr, pHome: hm(0), pCover: (side, line) => side === "home" ? hm(line) : 1 - hm(-line), pOver: dist.pOver };
    Object.assign(out, { sdMargin: dist.sdMargin, sdTotal: dist.sdTotal, pTie: dist.pTie, cal: dist.cal, marginFreq: dist.marginFreq, raw: dist, shape: corr });
    out.pAway = out.pCover("away", 0);
    return out;
  }
  return dist;
}
// Long-run NFL favourite win rate by closing spread (points -> probability), interpolated.
const NFL_FAV = [[0, .50], [1, .515], [1.5, .525], [2, .535], [2.5, .55], [3, .59], [3.5, .615], [4, .63], [4.5, .645], [5, .66], [5.5, .67], [6, .69], [6.5, .705],
  [7, .74], [7.5, .76], [8, .77], [8.5, .78], [9, .795], [9.5, .805], [10, .82], [10.5, .83], [11, .84], [11.5, .85], [12, .855], [12.5, .865], [13, .875], [13.5, .885],
  [14, .895], [15, .91], [16, .92], [17, .93], [18, .94], [20, .955], [24, .975], [30, .99]];
function nflFavWinPct(s) {
  s = Math.abs(s); if (s >= 30) return 0.99;
  for (let i = 1; i < NFL_FAV.length; i++) if (s <= NFL_FAV[i][0]) { const [x0, y0] = NFL_FAV[i - 1], [x1, y1] = NFL_FAV[i]; return y0 + (y1 - y0) * (s - x0) / (x1 - x0); }
  return 0.99;
}

// ── Kalshi market parsing ────────────────────────────────────────────────────
function normName(s) {
  return String(s || "").toLowerCase()
    .replace(/&/g, " and ").replace(/\bst\.?(?=\s|$)/g, "state").replace(/\buniv(ersity)?\.?\b/g, "")
    .replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}
function nameScore(kName, team) {
  const k = normName(kName);
  const two = /^(los angeles|new york) ([a-z])$/.exec(k);
  if (two && normName(team.location) === two[1]) return String(team.abbr || "").toLowerCase().endsWith(two[2]) ? 1 : 0.05;
  const cands = [team.location, team.short, team.name, team.abbr].map(normName).filter(Boolean);
  let best = 0;
  for (const c of cands) {
    if (k === c) best = Math.max(best, 1);
    else if (k.startsWith(c + " ") || c.startsWith(k + " ")) best = Math.max(best, 0.8);
    else {
      const kt = new Set(k.split(" ")), ct = c.split(" ");
      const hit = ct.filter(x => kt.has(x)).length;
      if (hit) best = Math.max(best, 0.5 * hit / Math.max(ct.length, kt.size));
    }
  }
  return best;
}
// Which side ("home"/"away") a Kalshi team name refers to.
function sideForName(kName, g) {
  const h = nameScore(kName, g.home), a = nameScore(kName, g.away);
  if (Math.max(h, a) < 0.4 || h === a) return null;
  return h > a ? "home" : "away";
}
// Kalshi event titles are "Away vs Home". Score a Kalshi event against an ESPN game.
function matchEventScore(eventTitle, g) {
  const parts = String(eventTitle || "").split(/\s+(?:vs\.?|at|@)\s+/i);
  if (parts.length !== 2) return 0;
  const s1 = nameScore(parts[0], g.away) + nameScore(parts[1], g.home);
  const s2 = nameScore(parts[0], g.home) + nameScore(parts[1], g.away);
  return Math.max(s1, s2) / 2;
}

const dollars = (x) => x == null || x === "" ? null : Math.round(parseFloat(x) * 100); // -> integer cents

// Normalize a Kalshi market object into {ticker, kind, side, line, yesBid, yesAsk, noBid, noAsk, sizes}
function parseKalshiMarket(m, g) {
  const t = m.ticker || "";
  const yesBid = dollars(m.yes_bid_dollars), yesAsk = dollars(m.yes_ask_dollars);
  const noBid = m.no_bid_dollars != null ? dollars(m.no_bid_dollars) : (yesAsk != null ? 100 - yesAsk : null);
  const noAsk = m.no_ask_dollars != null ? dollars(m.no_ask_dollars) : (yesBid != null ? 100 - yesBid : null);
  const base = {
    ticker: t, title: m.title, sub: m.yes_sub_title, status: m.status,
    yesBid, yesAsk, noBid, noAsk,
    yesBidSize: parseFloat(m.yes_bid_size_fp || 0), yesAskSize: parseFloat(m.yes_ask_size_fp || 0),
    volume: parseFloat(m.volume_fp || 0), lastPrice: dollars(m.last_price_dollars), result: m.result,
  };
  const series = t.split("-")[0];
  const half = /1H/.test(series);
  if (/GAME$/.test(series) || series === "KXNCAAF1H") {
    const side = sideForName(m.yes_sub_title, g);
    return side ? { ...base, kind: "win", side, line: 0, half } : null;
  }
  if (/SPREAD$/.test(series)) {
    const mm = String(m.yes_sub_title || m.title).match(/^(.*?)\s+wins by over\s+([\d.]+)/i);
    if (!mm) return null;
    const side = sideForName(mm[1], g);
    const line = m.floor_strike != null ? Number(m.floor_strike) : parseFloat(mm[2]);
    return side ? { ...base, kind: "spread", side, line, half } : null;
  }
  if (/TOTAL$/.test(series)) {
    const mm = String(m.yes_sub_title || m.title).match(/over\s+([\d.]+)/i);
    const line = m.floor_strike != null ? Number(m.floor_strike) : mm ? parseFloat(mm[1]) : null;
    return line != null ? { ...base, kind: "total", side: "over", line, half } : null;
  }
  return null;
}

// ── Fair value ──────────────────────────────────────────────────────────────
function modelYesProb(mk, pr) {
  if (pr && pr.margins) { // simulated distribution
    if (mk.kind === "win") return mk.side === "home" ? pr.pHome : 1 - pr.pHome;
    if (mk.kind === "spread") return pr.pCover(mk.side, mk.line);
    if (mk.kind === "total") return pr.pOver(mk.line);
    return null;
  }
  if (mk.kind === "win") return mk.side === "home" ? pHomeWin(pr) : 1 - pHomeWin(pr);
  if (mk.kind === "spread") return pCover(pr, mk.side, mk.line);
  if (mk.kind === "total") return pOver(pr, mk.line);
  return null;
}
function mid(mk) {
  if (mk.yesBid == null || mk.yesAsk == null) return null;
  if (mk.yesBid <= 0 && mk.yesAsk >= 100) return null;
  return (mk.yesBid + mk.yesAsk) / 2;
}

// Fit the market's own distribution from the liquid part of a ladder.
// points: [{L, p, w}] with p = P(X > L). Under X ~ N(m, s): PhiInv(p) = (m - L)/s  =>  L = m - s*z.
// Weighted least squares of L on z gives m (intercept) and s (-slope).
function fitLadder(points, sdPrior) {
  const pts = points.filter(q => q.p > 0.06 && q.p < 0.94 && q.w > 0);
  if (!pts.length) return null;
  const zs = pts.map(q => PhiInv(q.p));
  if (pts.length === 1 || new Set(pts.map(q => q.L)).size < 2) {
    // one strike: only the mean is identified; use the prior SD
    let num = 0, den = 0; pts.forEach((q, i) => { num += q.w * (q.L + sdPrior * zs[i]); den += q.w; });
    return { m: num / den, s: sdPrior, n: pts.length, sdFit: false };
  }
  let W = 0, Sz = 0, SL = 0, Szz = 0, SzL = 0;
  pts.forEach((q, i) => { const z = zs[i]; W += q.w; Sz += q.w * z; SL += q.w * q.L; Szz += q.w * z * z; SzL += q.w * z * q.L; });
  const varZ = Szz / W - (Sz / W) ** 2;
  if (varZ < 0.02) { // strikes too close together to identify the SD
    let num = 0; pts.forEach((q, i) => { num += q.w * (q.L + sdPrior * zs[i]); });
    return { m: num / W, s: sdPrior, n: pts.length, sdFit: false };
  }
  const slope = (SzL / W - (Sz / W) * (SL / W)) / varZ;
  let s = clamp(-slope, sdPrior * 0.5, sdPrior * 1.8);
  const m = SL / W + s * (Sz / W);
  return { m, s, n: pts.length, sdFit: true };
}

// Market-implied distribution of the final home margin and total from the liquid Kalshi quotes.
function marketImplied(markets, pr, opts) {
  const maxWidth = (opts && opts.maxQuoteWidth) || 6;
  const mPts = [], tPts = [];
  for (const mk of markets) {
    if (mk.half || mk.status !== "active") continue;
    const md = mid(mk); if (md == null) continue;
    const width = mk.yesAsk - mk.yesBid; if (width > maxWidth) continue;
    const p = md / 100;
    const w = Math.log(1 + (mk.volume || 0)) / (1 + width) * (mk.kind === "win" ? 2 : 1);
    if (mk.kind === "win" || mk.kind === "spread") {
      // convert to P(homeMargin > Lh)
      if (mk.side === "home") mPts.push({ L: mk.line, p, w });
      else mPts.push({ L: -mk.line, p: 1 - p, w });
    } else if (mk.kind === "total") tPts.push({ L: mk.line, p, w });
  }
  const fm = fitLadder(mPts, pr.sdMargin), ft = fitLadder(tPts, pr.sdTotal);
  return { meanMargin: fm ? fm.m : null, sdMargin: fm ? fm.s : null, meanTotal: ft ? ft.m : null, sdTotal: ft ? ft.s : null,
           nMargin: fm ? fm.n : 0, nTotal: ft ? ft.n : 0, fitM: fm, fitT: ft };
}

// Blend our independent live model with the market-implied view. alpha = weight on our model.
function blendedProjection(g, pre, markets, alpha, opts) {
  const pr = liveProjection(g, pre);
  if (pr.final) return { ...pr, model: pr, implied: null };
  const imp = marketImplied(markets, pr, opts);
  const out = { ...pr, model: pr, implied: imp };
  if (imp.meanMargin != null) {
    out.meanMargin = alpha * pr.meanMargin + (1 - alpha) * imp.meanMargin;
    if (imp.fitM.sdFit && imp.fitM.n >= 3) out.sdMargin = alpha * pr.sdMargin + (1 - alpha) * imp.sdMargin;
  }
  if (imp.meanTotal != null) {
    out.meanTotal = alpha * pr.meanTotal + (1 - alpha) * imp.meanTotal;
    if (imp.fitT.sdFit && imp.fitT.n >= 3) out.sdTotal = alpha * pr.sdTotal + (1 - alpha) * imp.sdTotal;
  }
  return out;
}

// Kalshi taker fee per contract in cents: ceil(rate * C * P * (1-P)) over the order, ~ rate*P*(1-P) per contract
function feeCents(priceCents, count, rate) {
  const p = priceCents / 100;
  const total = Math.ceil(rate * count * p * (1 - p) * 100 - 1e-9); // cents for the whole order
  return total;
}

// ── Auto-trader decision engine ─────────────────────────────────────────────
const DEFAULT_CONFIG = {
  bankroll: 200,           // $ the bot may use (sizing base)
  kellyFraction: 0.15,     // fraction of full Kelly
  maxStake: 10,            // $ max cost of any one entry
  maxGameExposure: 30,     // $ max open cost per game
  maxTotalExposure: 60,    // $ max open cost overall
  maxDailyLoss: 40,        // $ realized+unrealized loss that halts new entries
  entryEdge: 8,            // cents of edge (after fees) needed to enter
  confirmTicks: 2,         // the edge must show on this many consecutive ticks
  minPrice: 12, maxPrice: 88, // only buy contracts priced within this band (cents)
  maxQuoteWidth: 6,        // skip markets whose bid/ask spread is wider than this (cents)
  minVolume: 500,          // skip thin markets
  takeProfit: 12,          // cents per contract above cost -> cash out
  takeProfitPct: 0.35,     // or +35% on cost
  stopLoss: 15,            // cents per contract below cost -> cash out
  trailArm: 10, trailGive: 6, // after +10c, give back at most 6c from the peak
  edgeExit: 3,             // sell when bid exceeds our fair value by this much
  maxExitWidth: 10,        // stops wait out quotes wider than this when the model says the bid is far too low
  holdToSettleAt: 96,      // don't sell above this bid; just let it settle
  noEntryLastSecs: 240,    // no new entries in the last 4 minutes
  freezeAfterScoreSecs: 25,// pause entries after any score change (data lag protection)
  staleDataSecs: 20,       // ignore games whose live data is older than this
  cooldownSecs: 60,        // wait after exiting a market before re-entering it
  anchorHoldSecs: 20,      // after a score/possession change, price the new state with the pre-change calibration this long
  leadEntries: true,       // allow entries in that window when the market hasn't moved yet (paper-test first)
  leadEntryEdge: 6,
  leadEntryWindowSecs: 10,
  leadMaxFeedLagSecs: 12,  // ...and only if our feed showed the score within this long of the play's real-world time
  leadRequireWallclock: true, // lead entries only this soon after the score (the market usually reprices in 10-30s)        // edge needed for a feed-lead entry (¢, after fee)
  leadTargetFrac: 0.8,     // feed-lead take-profit = this share of the entry edge...
  leadMinTarget: 4,        // ...but at least this many ¢
  leadMaxHoldSecs: 180,    // the catch-up is over by then: flatten a lead trade unless it's down more than leadMaxGiveBack
  leadMaxGiveBack: 6,
  maxMarketAgeSecs: 6,     // no entries on quotes older than this
  maxEdge: 25,             // an "edge" bigger than this is almost always stale or bad data, not opportunity
  modelEntries: false,     // also enter on plain model-vs-market disagreement (lost money in paper; off by default)
  leadMaxPreMove: 3,       // ...and only if no sensitive price in the game had already moved this many ¢ before our feed showed it
  anchorQuietSecs: 8,      // the pre-change calibration only refreshes after prices have been quiet this long
  maxStopsPerGame: 2,      // after this many stop-losses in one game, stop entering it
  gameTimeoutSecs: 300,    // after a stop-loss, no new entries in that game for this long
  blowoutMargin: 21,       // no entries in the 2nd half when a team leads by this much
  reentryEdgeBonus: 2,     // extra edge required to re-enter the same market
  maxPositionsPerGame: 3,
  alpha: 0.25,             // weight on our pregame-anchored model vs the market-calibrated one
  marketJumpCents: 6,      // if the moneyline moves this much while ESPN shows no change, freeze entries
  marketJumpFreezeSecs: 30,
  sims: 6000,
  feeRate: 0.07,
  kinds: { win: true, spread: true, total: true },
  includeHalf: false,
  restingTakeProfit: true, // also rest a GTC sell at the take-profit price on Kalshi
  exitSlippage: 1,         // cash-out limit this many cents under the bid so the IOC fills
  manageManual: false,
  liveFeed: "auto",         // game-state source: auto = furthest-along of ESPN core / Kalshi / ESPN scoreboard     // live: also manage CFB positions opened outside the bot
};

// sideBid/Ask: price to sell/buy the side we hold (yes/no) in cents
function sideQuotes(mk, side) {
  return side === "yes" ? { bid: mk.yesBid, ask: mk.yesAsk, askSize: mk.yesAskSize, bidSize: mk.yesBidSize }
                        : { bid: mk.noBid, ask: mk.noAsk, askSize: mk.yesBidSize, bidSize: mk.yesAskSize };
}

/*
  decide(input) -> { actions:[...], evals:[...] }
  input = {
    now (ms), cfg, dailyPnl ($, realized+unrealized for the session),
    games: [{ g (parsed ESPN), pre, dataTs, lastScoreChangeTs, markets:[parsed], enabled }],
    positions: { [ticker]: { side, count, avgCost (cents), peakBid, openedAt, gameId } },
    cooldowns: { [ticker]: { until, exits } },
    paused, killed
  }
  action = { type:"buy"|"sell", ticker, side, count, limit (cents), reason, gameId, fair, edge }
*/
const _keyState = new Map(), _anchors = new Map(), _midHist = new Map();
// mids of the liquid, price-sensitive rungs of a game's ladder (by ticker)
function ladderMids(markets) {
  const o = {};
  for (const mk of markets || []) {
    if (mk.half || mk.status !== "active" || mk.yesBid == null || mk.yesAsk == null || mk.yesAsk - mk.yesBid > 6) continue;
    const m = (mk.yesBid + mk.yesAsk) / 2; if (m >= 15 && m <= 85) o[mk.ticker] = m;
  }
  return o;
}
const feedFast = (g) => g.feed === "core";
function decide(input) {
  const cfg = { ...DEFAULT_CONFIG, ...(input.cfg || {}) };
  const now = input.now;
  const actions = [], evals = [];
  const positions = input.positions || {};
  const cooldowns = input.cooldowns || {};
  let totalExposure = 0; const gameExposure = {}; const gamePosCount = {};
  for (const [, p] of Object.entries(positions)) {
    const c = p.count * p.avgCost / 100;
    totalExposure += c; gameExposure[p.gameId] = (gameExposure[p.gameId] || 0) + c;
    gamePosCount[p.gameId] = (gamePosCount[p.gameId] || 0) + 1;
  }
  const lossHalt = (input.dailyPnl || 0) <= -Math.abs(cfg.maxDailyLoss);

  for (const G of input.games || []) {
    const g = G.g; if (!g) continue;
    const stale = !G.dataTs || (now - G.dataTs) / 1000 > cfg.staleDataSecs;
    const markets = (G.markets || []).filter(mk => mk && !mk.half); // 1H markets need a half-time model; not traded yet
    // Feed lead. Track the game's sensitive prices (liquid rungs priced 15-85¢): a touchdown barely moves a 95¢
    // moneyline but moves the spread/total ladder. The pre-change calibration ("anchor") is only refreshed while those
    // prices are quiet, so it can't soak up a market that is already reacting to a score our feed hasn't shown yet.
    const mids = ladderMids(markets);
    const maxMove = (a, b) => { let m = 0; if (!a || !b) return 99; for (const k in a) if (b[k] != null) m = Math.max(m, Math.abs(a[k] - b[k])); return m; };
    let hist = _midHist.get(g.id); if (!hist) { hist = []; _midHist.set(g.id, hist); }
    if (!hist.length || now - hist[hist.length - 1].ts >= 1000) hist.push({ ts: now, mids });
    while (hist.length > 1 && now - hist[1].ts > 90000) hist.shift();
    const snapAt = (ts) => { let best = null; for (const h of hist) { if (h.ts <= ts) best = h; else break; } return best; };
    const qs = snapAt(now - cfg.anchorQuietSecs * 1000);
    const quiet = !!qs && maxMove(qs.mids, mids) < cfg.leadMaxPreMove;
    const keySig = [g.home.score, g.away.score, g.possession, g.period > 4 ? "ot" : ""].join("|");
    let ks = _keyState.get(g.id);
    if (!ks || ks.sig !== keySig) {
      // how late our feed is: seconds between the play's real-world time and when we first saw the new score
      const lag = g.playWallclock ? (now - g.playWallclock) / 1000 : null;
      const before = g.playWallclock ? snapAt(g.playWallclock - 3000) : null;   // prices just before the play happened
      ks = { sig: keySig, ts: ks ? now : 0, midsAtChange: mids, lag, preMids: before && before.mids };
      _keyState.set(g.id, ks);
    }
    const sinceKey = (now - ks.ts) / 1000;
    const anchor = _anchors.get(g.id);
    // Hold only if the market hadn't already moved before our feed showed the change (else the old calibration would
    // count the score twice), and only until the market reacts.
    const preMoveOk = anchor && maxMove(anchor.mids, ks.midsAtChange) < cfg.leadMaxPreMove
                   && (!ks.preMids || maxMove(ks.preMids, ks.midsAtChange) < cfg.leadMaxPreMove);
    const feedTimely = ks.lag == null ? !cfg.leadRequireWallclock : ks.lag <= cfg.leadMaxFeedLagSecs;
    const reacted = maxMove(ks.midsAtChange, mids) >= 2 * cfg.leadMaxPreMove;
    const holding = cfg.anchorHoldSecs > 0 && g.state === "in" && anchor && anchor.keySig !== keySig && sinceKey < cfg.anchorHoldSecs && preMoveOk && !reacted;
    const live = liveDistribution(g, G.pre, markets, holding ? { ...cfg, hold: anchor } : cfg);
    if (!holding && sinceKey >= cfg.anchorHoldSecs && !stale && g.state === "in" && quiet)
      _anchors.set(g.id, { cal: live.cal, corr: live.corr, keySig, mids, ts: now });
    const scoreMoved = anchor && anchor.keySig.split("|").slice(0, 2).join("|") !== keySig.split("|").slice(0, 2).join("|");
    // quotes must be fresh: after a stall (a frozen background tab), old quotes next to a new score look like huge fake edges
    const marketFresh = !G.marketTs || (now - G.marketTs) / 1000 <= cfg.maxMarketAgeSecs;
    const leadOk = holding && scoreMoved && feedTimely && sinceKey <= cfg.leadEntryWindowSecs && cfg.leadEntries && feedFast(g) && !g.reviewPending && marketFresh;
    // a key change we can't trade on: block entries until the hold window passes (data / market catching up)
    const catchingUp = anchor && anchor.keySig !== keySig && sinceKey < cfg.anchorHoldSecs && !leadOk;
    const proj = live.dist; proj.cal = live.cal; proj.eff = live.eff; proj.target = live.target; proj.held = holding;
    const frozen = catchingUp || !leadOk && ((G.lastScoreChangeTs && (now - G.lastScoreChangeTs) / 1000 < cfg.freezeAfterScoreSecs)
                || (G.freezeUntil && G.freezeUntil > now)); // market jumped while our live data didn't change

    const cands = [];
    // kinds we already hold in this game: one position per kind per game (no stacking the ladder)
    const heldKinds = new Set(Object.entries(positions).filter(([, p]) => p.gameId === g.id && p.count > 0)
      .map(([t]) => (markets.find(m => m.ticker === t) || {}).kind));
    for (const mk of markets) {
      const pYes = modelYesProb(mk, proj);
      if (pYes == null) continue;
      const fairYes = pYes * 100;
      const pos = positions[mk.ticker];
      const ev = { ticker: mk.ticker, gameId: g.id, kind: mk.kind, side: mk.side, line: mk.line, fairYes,
                   yesBid: mk.yesBid, yesAsk: mk.yesAsk, held: !!pos, note: "" };
      evals.push(ev);

      // ── Exits (always evaluated, even when stale/paused — but stale data only allows price-based exits)
      if (pos && pos.count > 0) {
        const q = sideQuotes(mk, pos.side);
        const fairSide = pos.side === "yes" ? fairYes : 100 - fairYes;
        if (q.bid == null || q.bid <= 0) { ev.note = "no bid"; continue; }
        const gain = q.bid - pos.avgCost;
        const peak = Math.max(pos.peakBid || 0, q.bid);
        let reason = null;
        // A position you handed over (pos.manual): only your own price rules apply: no model "edge gone", no hold-to-settle.
        if (pos.manual) {
          const stopHeld = () => { const width = q.ask != null ? q.ask - q.bid : 99;
            if (/DELAY|SUSPEND/.test(g.statusName || "")) return `stop held: game delayed (bid ${q.bid}¢)`;
            if (width > cfg.maxExitWidth && fairSide - q.bid >= 8 && !proj.unreliable) return `stop held: quote ${q.bid}/${q.ask} too wide (fair ${fairSide.toFixed(0)}¢)`;
            return null; };
          if (input.killed) reason = "kill switch";
          else if (pos.tpPrice && q.bid >= pos.tpPrice) reason = `your target ${pos.tpPrice}¢ reached`;
          else if (pos.slPrice && q.bid <= pos.slPrice) { const h = stopHeld(); if (h) { ev.note = h; continue; } reason = `your stop ${pos.slPrice}¢ reached`; }
          else if (pos.trailGive && peak - pos.avgCost >= (pos.trailArm || 0) && peak - q.bid >= pos.trailGive) { const h = stopHeld(); if (h) { ev.note = h; continue; } reason = `trailing stop (high ${peak}¢, gave back ${peak - q.bid}¢)`; }
          if (reason) actions.push({ type: "sell", ticker: mk.ticker, side: pos.side, count: pos.count, limit: q.bid, reason, gameId: g.id, fair: fairSide, gain, manual: true });
          else ev.note = `watching (${gain >= 0 ? "+" : ""}${gain}¢)`;
          continue;
        }
        if (input.killed) reason = "kill switch";
        else if (q.bid >= cfg.holdToSettleAt) { ev.note = "holding to settle"; continue; }
        else if (pos.lead && pos.tpPrice && q.bid >= pos.tpPrice) reason = `lead target hit +${gain}¢`;
        else if (gain >= cfg.takeProfit || (pos.avgCost > 0 && gain / pos.avgCost >= cfg.takeProfitPct)) reason = `take profit +${gain}¢`;
        else if (pos.lead && pos.openedAt && (now - pos.openedAt) / 1000 > cfg.leadMaxHoldSecs && gain >= -cfg.leadMaxGiveBack) reason = `lead window over (${gain >= 0 ? "+" : ""}${gain}¢)`;
        else if (-gain >= cfg.stopLoss || (peak - pos.avgCost >= cfg.trailArm && peak - q.bid >= cfg.trailGive)) {
          // Don't dump into a pulled book: during a weather delay, or when the quote is wide and the model says the bid is far too low.
          const width = q.ask != null ? q.ask - q.bid : 99;
          if (/DELAY|SUSPEND/.test(g.statusName || "")) { ev.note = `stop held: game delayed (bid ${q.bid}¢)`; continue; }
          if (width > cfg.maxExitWidth && fairSide - q.bid >= cfg.stopLoss / 2 && !proj.unreliable) { ev.note = `stop held: quote ${q.bid}/${q.ask} too wide (fair ${fairSide.toFixed(0)}¢)`; continue; }
          reason = -gain >= cfg.stopLoss ? `stop loss ${gain}¢` : `trailing stop (peak ${peak}¢)`;
        }
        // lead positions: once the post-score view ends, fair is just the market's own price again, so "edge gone" is
        // meaningless; they exit by target, lead window or stop instead
        else if (!stale && !proj.unreliable && mk.status === "active" && q.bid - fairSide >= cfg.edgeExit && (!pos.lead || holding)) reason = `edge gone (fair ${fairSide.toFixed(0)}¢ < bid ${q.bid}¢)`;
        if (reason) {
          actions.push({ type: "sell", ticker: mk.ticker, side: pos.side, count: pos.count, limit: q.bid,
                         reason, gameId: g.id, fair: fairSide, gain });
        } else ev.note = `hold (${gain >= 0 ? "+" : ""}${gain}¢)`;
        continue;
      }

      // ── Entries
      if (input.killed || input.paused || lossHalt) { ev.note = lossHalt ? "loss limit hit" : "paused"; continue; }
      if (!G.enabled) { ev.note = "game off"; continue; }
      if (g.state !== "in") { ev.note = g.state === "pre" ? "not started" : "final"; continue; }
      if (/DELAY|SUSPEND|POSTPONE|HALFTIME/.test(g.statusName || "")) { ev.note = "game paused"; continue; }
      if (g.reviewPending) { ev.note = "review / PAT pending"; continue; }
      if (stale) { ev.note = "stale data"; continue; }
      if (frozen) { ev.note = "data catching up (score/market just moved)"; continue; }
      if (g.secondsLeft <= cfg.noEntryLastSecs || g.period > 4) { ev.note = "too late"; continue; }
      if (!cfg.kinds[mk.kind]) { ev.note = "kind off"; continue; }
      if (heldKinds.has(mk.kind)) { ev.note = "already hold this market type"; continue; }
      if (proj.unreliable) { ev.note = "overtime"; continue; }
      if (mk.status !== "active") { ev.note = mk.status; continue; }
      if (mk.yesBid == null || mk.yesAsk == null || mk.yesAsk - mk.yesBid > cfg.maxQuoteWidth) { ev.note = "wide quote"; continue; }
      if (mk.volume < cfg.minVolume) { ev.note = "thin"; continue; }
      const gcd = cooldowns["game:" + g.id];
      if (gcd && gcd.until > now) { ev.note = "game timeout after a stop-loss"; continue; }
      if (g.period >= 3 && Math.abs(g.home.score - g.away.score) >= cfg.blowoutMargin) { ev.note = "blowout (garbage time not modeled)"; continue; }
      const cd = cooldowns[mk.ticker];
      if (cd && cd.until > now) { ev.note = "cooldown"; continue; }
      if ((gamePosCount[g.id] || 0) >= cfg.maxPositionsPerGame) { ev.note = "max positions"; continue; }

      // Tonight's paper log: feed-lead entries 5W-2L +$3.72, model-disagreement entries 8W-14L -$21.48. So by default
      // the bot only enters on a fresh score the market hasn't priced; model entries are opt-in.
      if (!marketFresh) { ev.note = "quotes stale"; continue; }
      if (!leadOk && !cfg.modelEntries) { ev.note = "waiting for a fresh score (lead-only)"; continue; }
      const need = (leadOk ? cfg.leadEntryEdge : cfg.entryEdge) + (cd && cd.exits ? cfg.reentryEdgeBonus : 0);
      let best = null;
      for (const side of ["yes", "no"]) {
        const q = sideQuotes(mk, side);
        if (q.ask == null || q.ask < cfg.minPrice || q.ask > cfg.maxPrice) continue;
        const fairSide = side === "yes" ? fairYes : 100 - fairYes;
        const fee = cfg.feeRate * (q.ask / 100) * (1 - q.ask / 100) * 100;
        const edge = fairSide - q.ask - fee;
        if (!best || edge > best.edge) best = { side, q, fairSide, edge, fee };
      }
      if (!best) { ev.note = "price out of band"; continue; }
      ev.edge = best.edge; ev.bestSide = best.side;
      if (best.edge < need) { ev.note = `edge ${best.edge.toFixed(1)}¢`; continue; }
      if (best.edge > cfg.maxEdge) { ev.note = `edge ${best.edge.toFixed(0)}¢ too big to trust (stale data?)`; continue; }

      // Kelly sizing for a binary contract: f* = (p - c) / (1 - c)
      const p = best.fairSide / 100, c = best.q.ask / 100;
      const kelly = Math.max(0, (p - c) / (1 - c));
      let stake = Math.min(cfg.bankroll * kelly * cfg.kellyFraction, cfg.maxStake);
      stake = Math.min(stake, cfg.maxGameExposure - (gameExposure[g.id] || 0), cfg.maxTotalExposure - totalExposure);
      let count = Math.floor(stake / c);
      if (best.q.askSize > 0) count = Math.min(count, Math.floor(best.q.askSize));
      if (count < 1) { ev.note = "size < 1"; continue; }
      ev.note = `candidate ${best.edge.toFixed(1)}¢`;
      cands.push({ type: "buy", ticker: mk.ticker, side: best.side, count, limit: best.q.ask, kind: mk.kind,
                   reason: `${leadOk ? "FEED LEAD " : ""}edge ${best.edge.toFixed(1)}¢ (fair ${best.fairSide.toFixed(0)}¢ vs ask ${best.q.ask}¢)`, lead: leadOk,
                   diag: leadOk ? { preMove: +maxMove(anchor.mids, ks.midsAtChange).toFixed(1), sinceMove: +maxMove(ks.midsAtChange, mids).toFixed(1),
                                    sinceKey: +sinceKey.toFixed(1), feedLagSecs: ks.lag != null ? +ks.lag.toFixed(1) : null, anchorAgeSecs: Math.round((now - anchor.ts) / 1000), rungMidAtAnchor: anchor.mids[mk.ticker] } : undefined,
                   gameId: g.id, fair: best.fairSide, edge: best.edge, cost: count * c,
                   takeProfitPrice: Math.min(99, best.q.ask + (leadOk ? Math.max(cfg.leadMinTarget, Math.round(best.edge * cfg.leadTargetFrac)) : cfg.takeProfit)) });
    }
    // At most one new entry per game per tick (the best edge): the ladders are highly correlated,
    // and "LSU wins YES" and "Tennessee wins NO" are the same bet.
    if (cands.length) {
      cands.sort((x, y) => y.edge - x.edge);
      const pick = cands[0];
      actions.push(pick);
      totalExposure += pick.cost; gameExposure[g.id] = (gameExposure[g.id] || 0) + pick.cost;
      gamePosCount[g.id] = (gamePosCount[g.id] || 0) + 1;
    }
    G.proj = proj;
  }
  return { actions, evals };
}

const API = { P, Phi, PhiInv, erf, clamp, median, expectedPoints, clockToSeconds, parseEspnEvent,
  liveProjection, pHomeWin, pCover, pOver, pregameSim, normName, nameScore, sideForName, matchEventScore,
  parseKalshiMarket, modelYesProb, mid, marketImplied, blendedProjection, feeCents, DEFAULT_CONFIG,
  SPORTS, pregameDriveSim, driveProbsNfl, nflFavWinPct, sideQuotes, decide, applyKalshiLive, applyEspnCore, feedProgress, fitLadder, driveProbs, simRemaining, liveDistribution, teamPoints, mulberry32 };
if (typeof module !== "undefined" && module.exports) module.exports = API;
else root.CFB = API;
})(typeof window !== "undefined" ? window : globalThis);
