// node --test tests/*.test.mjs
import test from "node:test";
import assert from "node:assert";
import { createRequire } from "node:module";
const CFB = createRequire(import.meta.url)("../js/cfb-engine.js");

const team = (id, abbr, location, short, score = 0) => ({ id, abbr, name: location + " X", short, location, mascot: "X", score });
function game(over = {}) {
  return { id: "1", state: "in", statusName: "STATUS_IN_PROGRESS", period: 2, clock: "7:30", secondsLeft: 2250,
    home: team("h", "TENN", "Tennessee", "Tennessee", 14), away: team("a", "LSU", "LSU", "LSU", 10),
    possession: "home", down: 1, distance: 10, yardsToGoal: 70, ...over };
}
function mk(kind, side, line, bid, ask, extra = {}) {
  return { ticker: `KX-${kind}-${side}-${line}`, kind, side, line, yesBid: bid, yesAsk: ask, noBid: 100 - ask, noAsk: 100 - bid,
    yesBidSize: 500, yesAskSize: 500, volume: 50000, status: "active", half: false, ...extra };
}

test("Phi / PhiInv are inverses", () => {
  for (const p of [0.01, 0.1, 0.37, 0.5, 0.9, 0.99]) assert.ok(Math.abs(CFB.Phi(CFB.PhiInv(p)) - p) < 1e-4);
});

test("ESPN yardLine is measured from the home goal line", () => {
  const ev = { id: "9", date: "2026-11-22T00:00Z", status: { period: 1, displayClock: "10:00", type: { state: "in", name: "STATUS_IN_PROGRESS" } },
    competitions: [{ competitors: [
      { id: "h", homeAway: "home", score: "0", team: { abbreviation: "FAU", displayName: "FAU", shortDisplayName: "FAU", location: "FAU" } },
      { id: "a", homeAway: "away", score: "0", team: { abbreviation: "USF", displayName: "USF", shortDisplayName: "USF", location: "USF" } }],
      situation: { possession: "h", yardLine: 26, down: 1, distance: 10 } }] };
  assert.equal(CFB.parseEspnEvent(ev).yardsToGoal, 74);         // home ball at own 26
  ev.competitions[0].situation.possession = "a";
  assert.equal(CFB.parseEspnEvent(ev).yardsToGoal, 26);         // away ball at the home 26
  assert.equal(CFB.parseEspnEvent(ev).secondsLeft, 3 * 900 + 600);
});

test("Kalshi market parsing maps team names to sides", () => {
  const g = game({ away: team("a", "WSU", "Washington State", "Washington St"), home: team("h", "TXST", "Texas State", "Texas St") });
  const m = CFB.parseKalshiMarket({ ticker: "KXNCAAFSPREAD-26NOV21WSUTXST-TXST15", yes_sub_title: "Texas St. wins by over 14.5 points", floor_strike: 14.5,
    status: "active", yes_bid_dollars: "0.6500", yes_ask_dollars: "0.7000", volume_fp: "1000" }, g);
  assert.deepEqual([m.kind, m.side, m.line, m.yesBid, m.yesAsk, m.noBid], ["spread", "home", 14.5, 65, 70, 30]);
  const w = CFB.parseKalshiMarket({ ticker: "KXNCAAFGAME-26NOV21WSUTXST-WSU", yes_sub_title: "Washington St.", status: "active", yes_bid_dollars: "0.05", yes_ask_dollars: "0.06" }, g);
  assert.equal(w.side, "away");
  const t = CFB.parseKalshiMarket({ ticker: "KXNCAAFTOTAL-26NOV21WSUTXST-62", yes_sub_title: "Over 61.5 points", floor_strike: 61.5, status: "active", yes_bid_dollars: "0.74", yes_ask_dollars: "0.76" }, g);
  assert.deepEqual([t.kind, t.line], ["total", 61.5]);
  assert.ok(CFB.matchEventScore("Washington St. vs Texas St.", g) >= 0.9);
});

test("drive sim: final-minute leader with the ball almost always wins; key numbers show up", () => {
  const g = game({ period: 4, secondsLeft: 60, home: team("h", "H", "Home", "Home", 21), away: team("a", "A", "Away", "Away", 14), possession: "home", yardsToGoal: 60 });
  const d = CFB.simRemaining(g, 30, 25, 5000, { seed: 1 });
  assert.ok(d.pHome > 0.97, "pHome " + d.pHome);
  // 7-point lead, ~1 minute: covering 7.5 is rare; covering 6.5 is likely
  assert.ok(d.pCover("home", 6.5) > 0.9);
  assert.ok(d.pCover("home", 7.5) < 0.25);
});

test("calibration reproduces the market moneyline", () => {
  const g = game();
  const markets = [mk("win", "home", 0, 69, 71), mk("win", "away", 0, 29, 31), mk("total", "over", 49.5, 49, 51)];
  const L = CFB.liveDistribution(g, { spreadHome: 3, total: 50 }, markets, { alpha: 0 });
  assert.ok(Math.abs(L.dist.pHome - 0.70) < 0.03, "pHome " + L.dist.pHome);
  assert.ok(Math.abs(L.dist.pOver(49.5) - 0.50) < 0.04, "pOver " + L.dist.pOver(49.5));
});

test("decide: take profit, stop loss, trailing stop, and hold-to-settle", () => {
  const g = game();
  const m = mk("spread", "home", 3.5, 60, 62);
  const base = { now: Date.now(), cfg: { alpha: 0 }, games: [{ g, pre: { spreadHome: 3, total: 50 }, dataTs: Date.now(), markets: [m], enabled: true }] };
  const sell = (pos) => CFB.decide({ ...base, positions: { [m.ticker]: { gameId: "1", side: "yes", count: 10, ...pos } } }).actions.find(a => a.type === "sell");
  assert.match(sell({ avgCost: 45 }).reason, /take profit/);          // bid 60 vs cost 45 = +15
  assert.match(sell({ avgCost: 78 }).reason, /stop loss/);            // -18
  assert.match(sell({ avgCost: 55, peakBid: 70 }).reason, /trailing/); // up 15 at peak, gave back 10
  const held = CFB.decide({ ...base, games: [{ ...base.games[0], markets: [mk("spread", "home", 3.5, 97, 98)] }],
    positions: { [m.ticker]: { gameId: "1", side: "yes", count: 10, avgCost: 50 } } });
  assert.equal(held.actions.length, 0);
  // NO side uses the NO bid (100 - yes ask)
  assert.match(sell({ side: "no", avgCost: 20 }).reason, /take profit/); // no bid = 38
});

test("decide: one entry per game, no entries when paused/stale/frozen/late/delayed", () => {
  const g = game();
  // deliberately mispriced ladder so there is an edge to take
  const markets = [mk("win", "home", 0, 69, 71), mk("win", "away", 0, 29, 31), mk("total", "over", 49.5, 49, 51),
                   mk("spread", "home", 0.5, 40, 42), mk("spread", "home", 1.5, 39, 41)];
  const G = { g, pre: { spreadHome: 3, total: 50 }, dataTs: Date.now(), markets, enabled: true };
  const run = (over, gOver) => CFB.decide({ now: Date.now(), cfg: { alpha: 0, entryEdge: 5, modelEntries: true }, positions: {}, games: [{ ...G, ...gOver }], ...over }).actions.filter(a => a.type === "buy");
  const buys = run({});
  assert.equal(buys.length, 1, JSON.stringify(buys));
  assert.equal(run({ paused: true }).length, 0);
  assert.equal(run({}, { dataTs: Date.now() - 60000 }).length, 0);
  assert.equal(run({}, { lastScoreChangeTs: Date.now() - 5000 }).length, 0);
  assert.equal(run({}, { freezeUntil: Date.now() + 5000 }).length, 0);
  assert.equal(run({}, { enabled: false }).length, 0);
  assert.equal(run({}, { g: { ...g, period: 4, secondsLeft: 100 } }).length, 0);
  assert.equal(run({}, { g: { ...g, statusName: "STATUS_DELAYED" } }).length, 0);
  assert.equal(run({ dailyPnl: -1000 }).length, 0);
  // sizing respects maxStake
  const b = buys[0];
  assert.ok(b.count * b.limit / 100 <= 10 + 1e-9);
});

test("Kalshi live feed overlay: score, clock, possession and field position", () => {
  const g = game({ home: team("h", "TXST", "Texas State", "Texas St", 14), away: team("a", "WSU", "Washington State", "Washington St", 7) });
  const ms = { details: { home_team_id: "K-TXST", away_team_id: "K-WSU" } };
  const d = { home_points: 21, away_points: 7, quarter: 3, clock: "12:34", status: "inprogress",
    situation: { possession_team_id: "K-WSU", side_team_id: "K-WSU", yardline: 30, down: 2, yfd: 7 }, last_updated_ts: 1795307700 };
  const out = CFB.applyKalshiLive(g, d, ms, false);
  assert.equal(out.home.score, 21); assert.equal(out.period, 3); assert.equal(out.secondsLeft, 900 + 754);
  assert.equal(out.possession, "away"); assert.equal(out.yardsToGoal, 70); assert.equal(out.down, 2); assert.equal(out.distance, 7);
  // ball on the opponent's side
  const out2 = CFB.applyKalshiLive(g, { ...d, situation: { ...d.situation, side_team_id: "K-TXST", yardline: 12 } }, ms, false);
  assert.equal(out2.yardsToGoal, 12);
  // flipped orientation (Kalshi home == ESPN away)
  const out3 = CFB.applyKalshiLive(g, { ...d, home_points: 7, away_points: 21 }, { details: { home_team_id: "K-WSU", away_team_id: "K-TXST" } }, true);
  assert.equal(out3.home.score, 21); assert.equal(out3.possession, "away");
  // halftime and pending review
  assert.equal(CFB.applyKalshiLive(g, { ...d, status: "halftime" }, ms, false).statusName, "STATUS_HALFTIME");
  assert.ok(CFB.applyKalshiLive(g, { ...d, is_under_review: true }, ms, false).reviewPending);
});

test("ESPN core overlay: status clock, play score, possession by team $ref", () => {
  const g = game({ home: team("2390", "MIA", "Miami", "Miami", 3), away: team("259", "VT", "Virginia Tech", "Virginia Tech", 7) });
  const ref = (id) => ({ $ref: `http://sports.core.api.espn.com/v2/sports/football/leagues/college-football/seasons/2026/teams/${id}?lang=en` });
  const c = { status: { displayClock: "11:36", period: 2, type: { name: "STATUS_IN_PROGRESS", state: "in" } },
    situation: { team: ref("2390"), yardLine: 90, down: 2, distance: 8 }, play: { homeScore: 3, awayScore: 14, text: "pass" } };
  const out = CFB.applyEspnCore(g, c);
  assert.equal(out.feed, "core"); assert.equal(out.away.score, 14); assert.equal(out.secondsLeft, 2 * 900 + 696);
  assert.equal(out.possession, "home"); assert.equal(out.yardsToGoal, 10); assert.equal(out.down, 2);
  const out2 = CFB.applyEspnCore(g, { ...c, situation: { team: ref("259"), yardLine: 30, down: 1, distance: 10 } });
  assert.equal(out2.possession, "away"); assert.equal(out2.yardsToGoal, 30);
  assert.equal(CFB.applyEspnCore(g, { ...c, status: { ...c.status, type: { name: "STATUS_HALFTIME", state: "in" } } }).secondsLeft, 1800);
  // progress picks the feed with the newer score
  assert.ok(CFB.feedProgress(out) > CFB.feedProgress(g));
});

test("decide: stops wait out a delayed game or a pulled, wide book", () => {
  const g = game();
  const m = mk("spread", "home", 3.5, 40, 62);   // 22¢ wide
  const run = (gOver, mOver) => CFB.decide({ now: Date.now(), cfg: { alpha: 0 }, positions: { [m.ticker]: { gameId: "1", side: "yes", count: 10, avgCost: 60 } },
    games: [{ g: { ...g, ...gOver }, pre: { spreadHome: 3, total: 50 }, dataTs: Date.now(), markets: [{ ...m, ...mOver }], enabled: true }] }).actions.filter(a => a.type === "sell");
  assert.equal(run({ statusName: "STATUS_DELAYED" }, { yesBid: 40, yesAsk: 42, noBid: 58, noAsk: 60 }).length, 0);
  assert.equal(run({}, { yesBid: 40, yesAsk: 42, noBid: 58, noAsk: 60 }).length, 1);   // tight quote: stop fires
});

test("decide: feed lead — a fresh score the market hasn't priced yet is tradable; a market that moved first is not", () => {
  const markets = [mk("win", "home", 0, 59, 61), mk("win", "away", 0, 39, 41), mk("total", "over", 49.5, 49, 51),
                   mk("spread", "home", 3.5, 44, 46), mk("spread", "home", 7.5, 30, 32)];
  const base = (id, gOver, mks, now) => ({ g: game({ id, feed: "core", ...gOver }), pre: { spreadHome: 3, total: 50 }, dataTs: now, markets: mks || markets, enabled: true });
  const run = (id, gOver, mks, now) => CFB.decide({ now, cfg: { alpha: 0 }, positions: {}, games: [base(id, gOver, mks, now)] }).actions.filter(a => a.type === "buy");
  const t0 = Date.now();
  run("L1", {}, markets, t0);                         // first sight: anchor fitted at 14-10, home ball
  run("L1", {}, markets, t0 + 25000);
  // home scores a TD (21-10, away ball) per the core feed; Kalshi prices unchanged
  const td = { home: team("h", "TENN", "Tennessee", "Tennessee", 21), possession: "away", yardsToGoal: 75 };
  const b = run("L1", { ...td, playWallclock: t0 + 24000 }, markets, t0 + 26000);   // feed 2s behind the play
  assert.ok(b.length === 1 && /FEED LEAD/.test(b[0].reason) && b[0].side === "yes", JSON.stringify(b));
  // same, but the moneyline had already jumped before the feed showed the score: no lead entry
  run("L2", {}, markets, t0); run("L2", {}, markets, t0 + 25000);
  const moved = markets.map(m => m.kind === "win" ? { ...m, yesBid: m.side === "home" ? 74 : 24, yesAsk: m.side === "home" ? 76 : 26 } : m);
  const b2 = run("L2", { ...td, playWallclock: t0 + 24000 }, moved, t0 + 26000);
  assert.equal(b2.filter(a => /FEED LEAD/.test(a.reason)).length, 0);
  // a feed that showed the score 20s after the play: the market has had time to see it on TV
  run("L4", {}, markets, t0); run("L4", {}, markets, t0 + 25000);
  assert.equal(run("L4", { ...td, playWallclock: t0 + 6000 }, markets, t0 + 26000).filter(a => /FEED LEAD/.test(a.reason)).length, 0);
  // lead-only mode (default): no entry without a fresh score
  run("L3", {}, markets, t0); assert.equal(run("L3", {}, markets, t0 + 25000).length, 0);
});

test("decide: feed-lead positions exit at their own target or when the lead window is over", () => {
  const g = game({ id: "X1" });
  const m = mk("spread", "home", 3.5, 50, 52);
  const run = (pos, now) => CFB.decide({ now, cfg: { alpha: 0 }, positions: { [m.ticker]: { gameId: "X1", side: "yes", count: 10, lead: true, ...pos } },
    games: [{ g, pre: { spreadHome: 3, total: 50 }, dataTs: now, markets: [m], enabled: true }] }).actions.filter(a => a.type === "sell");
  const t = Date.now();
  assert.match(run({ avgCost: 45, tpPrice: 50, openedAt: t }, t)[0].reason, /lead target/);
  assert.match(run({ avgCost: 49, tpPrice: 56, openedAt: t - 200000 }, t)[0].reason, /lead window over/);
  assert.equal(run({ avgCost: 49, tpPrice: 56, openedAt: t - 30000 }, t).length, 0);
});

test("decide: positions you hand over follow only your price rules", () => {
  const g = game();
  const m = mk("spread", "home", 3.5, 60, 62);
  const base = { now: Date.now(), cfg: { alpha: 0 }, games: [{ g, pre: { spreadHome: 3, total: 50 }, dataTs: Date.now(), markets: [m], enabled: true }] };
  const run = (pos, extra = {}) => CFB.decide({ ...base, ...extra, positions: { [m.ticker]: { gameId: "1", side: "yes", count: 10, manual: true, ...pos } } }).actions.find(a => a.type === "sell");
  assert.equal(run({ avgCost: 45 }), undefined);                                  // +15 but no rules set: the bot's own take-profit doesn't apply
  assert.match(run({ avgCost: 45, tpPrice: 60 }).reason, /your target 60/);
  assert.equal(run({ avgCost: 45, tpPrice: 61 }), undefined);
  assert.match(run({ avgCost: 70, slPrice: 60 }).reason, /your stop 60/);
  assert.match(run({ avgCost: 50, peakBid: 70, trailArm: 10, trailGive: 8 }).reason, /trailing/);   // high 70, now 60
  assert.equal(run({ avgCost: 50, peakBid: 66, trailArm: 10, trailGive: 8 }), undefined);           // gave back only 6
  // a 97c bid on your own position sells at your target (no hold-to-settle)
  const hi = mk("spread", "home", 3.5, 97, 98);
  const r = CFB.decide({ ...base, games: [{ ...base.games[0], markets: [hi] }], positions: { [hi.ticker]: { gameId: "1", side: "yes", count: 5, manual: true, avgCost: 50, tpPrice: 95 } } });
  assert.match(r.actions[0].reason, /your target/);
  // stops wait out a delayed game
  const delayed = { ...base, games: [{ ...base.games[0], g: game({ statusName: "STATUS_DELAYED" }) }] };
  assert.equal(run({ avgCost: 70, slPrice: 60 }, delayed), undefined);
  // the kill switch cashes them out too
  assert.match(run({ avgCost: 45 }, { killed: true }).reason, /kill/);
});

test("NFL pregame drive sim: median on the spread and total, key numbers, favourite win rate from the long-run table", () => {
  const d = CFB.pregameDriveSim(7.5, 44.5, 40000, "nfl");
  assert.ok(Math.abs(d.pCover("home", 7.5) - 0.5) < 0.03, "half the sims cover a 7.5 spread");
  assert.ok(Math.abs(d.pOver(44.5) - 0.5) < 0.03, "half go over the total");
  assert.ok(Math.abs(d.pHome - CFB.nflFavWinPct(7.5)) < 0.02, "7.5-point favourite wins ~76%");
  const f3 = d.marginFreq(3) + d.marginFreq(-3), f5 = d.marginFreq(5) + d.marginFreq(-5);
  assert.ok(f3 > 1.5 * f5, "3 is a key number, 5 is not");
  assert.ok(d.pTie < 0.02);
  // Kalshi's two-team-city names
  const g = { home: { location: "Los Angeles", short: "Chargers", name: "Los Angeles Chargers", abbr: "LAC" }, away: { location: "New York", short: "Jets", name: "New York Jets", abbr: "NYJ" } };
  assert.equal(CFB.sideForName("Los Angeles C", g), "home");
  assert.equal(CFB.sideForName("New York J", g), "away");
  assert.ok(CFB.nameScore("Los Angeles R", g.home) < 0.1);
});
