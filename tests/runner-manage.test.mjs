// Offline check of the runner's managed-position flow with stubbed feeds (no network, no Kalshi).
import assert from "node:assert";
import { Runner } from "../runner/index.js";

const store = {};
const state = { storage: { get: async k => store[k], put: async (k, v) => { store[k] = v; }, setAlarm: async () => {} }, blockConcurrencyWhile: async f => f() };
const env = { KALSHI_API_KEY_ID: "x", KALSHI_PRIVATE_KEY: "x" };   // hasCredentials() true; network calls are stubbed below
const r = new Runner(state, env); await r.ready;

const T = "KXNCAAFSPREAD-26NOV22AAABBB-BBB7";
const g = { id: "9", state: "in", statusName: "STATUS_IN_PROGRESS", period: 3, clock: "5:00", secondsLeft: 1200, home: { abbr: "BBB", score: 21, id: "h" }, away: { abbr: "AAA", score: 14, id: "a" }, possession: "home", down: 1, distance: 10, yardsToGoal: 60 };
let bid = 60;
const mkt = () => ({ ticker: T, kind: "spread", side: "home", line: 6.5, yesBid: bid, yesAsk: bid + 2, noBid: 98 - bid, noAsk: 100 - bid, yesBidSize: 500, yesAskSize: 500, volume: 50000, status: "active", half: false });
r.refreshEvents = async () => {}; r.refreshScoreboard = async () => { r.mem.sbGames = [g]; r.mem.gs[g.id] = r.mem.gs[g.id] || { sbTs: Date.now(), suffix: "26NOV22AAABBB" }; r.mem.gs[g.id].sbTs = Date.now(); };
r.refreshCore = async () => {}; r.refreshMarkets = async () => { r.mem.markets[g.id] = [mkt()]; r.mem.marketTs[g.id] = Date.now(); };
r.refreshLivePositions = async () => { r.mem.myPositions = r.mem.livePositions = { [T]: { side: "yes", count: 10, avgCost: 50, gameId: g.id, botOwned: false, unmanaged: !r.s.managed[T] } }; r.mem.posTs = Date.now(); };
r.s.pre[g.id] = { spreadHome: -3, total: 50 };
const post = (path, body) => r.fetch(new Request("https://x/" + path, { method: "POST", body: JSON.stringify(body) })).then(x => x.json());

// paper, nothing managed: no action on your position
await post("start", { mode: "paper" });
r.s.startedAt = Date.now() - 60000;
await r.tick();
assert.equal(r.s.shadow.trades.length, 0);
assert.equal(r.s.entries, false);

// manage with a target of 65: below -> nothing; at 65 -> one shadow sell, logged, not repeated
let st = await post("manage", { ticker: T, rules: { tpPrice: 65, slPrice: 40 } });
assert.equal(st.managedCount, 1);
await r.tick(); assert.equal(r.s.shadow.trades.length, 0);
bid = 66; await r.tick();
assert.equal(r.s.shadow.trades.length, 1); assert.match(r.s.shadow.trades[0].reason, /your target 65/);
await r.tick(); assert.equal(r.s.shadow.trades.length, 1, "shadow sell must not repeat");
assert.match(r.s.log[0].msg, /would sell your 10× .* Nothing was sold/);

// bad rules are rejected
assert.match((await post("manage", { ticker: T, rules: { tpPrice: 40, slPrice: 50 } })).error, /below the target/);
assert.match((await post("manage", { ticker: "KXNFL-1", rules: { tpPrice: 40 } })).error, /college football/);

// trailing stop in live mode: the sell goes to liveExecute with manual:true; a bot-only position list stays untouched
await post("manage", { ticker: T, rules: { trailArm: 10, trailGive: 6 } });
await post("stop", {});
r.env = { ...env, KALSHI_TRADING_ENABLED: "1" };
await post("start", { mode: "live", confirm: "LIVE" });
r.s.startedAt = Date.now() - 60000;
const sent = []; r.liveExecute = async (a) => { sent.push(a); };
bid = 70; await r.tick(); assert.equal(sent.length, 0);           // high 70, armed (+20)
bid = 66; await r.tick(); assert.equal(sent.length, 0);           // gave back 4
bid = 63; await r.tick(); assert.equal(sent.length, 1);           // gave back 7 -> sell
assert.equal(sent[0].manual, true); assert.match(sent[0].reason, /trailing/); assert.equal(sent[0].count, 10);

// stop managing
st = await post("manage", { ticker: T, rules: null });
assert.equal(st.managedCount, 0);
sent.length = 0; bid = 30; await r.tick(); assert.equal(sent.length, 0, "unmanaged position is never sold");

// status lists your positions with their rules
const status = await r.fetch(new Request("https://x/status")).then(x => x.json());
assert.equal(status.myPositions.length, 1); assert.equal(status.myPositions[0].rules, null);
console.log("manage flow: all checks passed");
