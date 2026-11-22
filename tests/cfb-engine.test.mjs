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
  const run = (over, gOver) => CFB.decide({ now: Date.now(), cfg: { alpha: 0, entryEdge: 5 }, positions: {}, games: [{ ...G, ...gOver }], ...over }).actions.filter(a => a.type === "buy");
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
