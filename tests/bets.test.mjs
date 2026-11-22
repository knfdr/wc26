import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const B = createRequire(import.meta.url)("../js/bets.js");

test("grades need both chance and value", () => {
  assert.equal(B.grade(0.65, 52).key, "STRONG");     // 65% at 52¢: +13
  assert.equal(B.grade(0.75, 80).key, "AVOID");      // likely winner, priced too high
  assert.equal(B.grade(0.50, 45).key, "GOOD");       // +5, 50%
  assert.equal(B.grade(0.25, 18).key, "SMALL");      // long shot with +7
  assert.ok(B.grade(0.25, 18).longShot);
  assert.equal(B.grade(0.50, 49).key, "NONE");
  assert.equal(B.grade(0.5, 0), null);
});

test("stake scales from the base bet and is capped", () => {
  const s = B.DEFAULTS;
  assert.equal(B.stake(B.grade(0.65, 54.5), "nfl", s), 40);   // edge 10.5 = 1.5× bar → 2× base
  assert.equal(B.stake(B.grade(0.6, 53), "nfl", s), 30);      // edge 7 → nudged to 0.75
  assert.ok(B.stake(B.grade(0.95, 40), "nfl", s) <= 60);
  assert.equal(B.stake(B.grade(0.75, 80), "nfl", s), 0);
});

test("ticket math", () => {
  assert.deepEqual(B.ticket(20, 40), { count: 50, cost: 20, payout: 50, profit: 30 });
  assert.equal(B.ticket(1, 60).count, 1);
});

test("record keeps LOCK/HIGH history as STRONG/GOOD and drops the rest", () => {
  const r = B.record([{ sport: "MLB", tier: "LOCK", result: "win" }, { sport: "MLB", tier: "HIGH", result: "loss" },
    { sport: "MLB", tier: "LEAN", result: "win" }, { sport: "NFL", tier: "STRONG", result: "pending" }]);
  assert.equal(r.bySport.mlb.STRONG.w, 1); assert.equal(r.bySport.mlb.GOOD.l, 1); assert.equal(r.all.w, 1);
  assert.equal(r.bySport.nfl.pending, 1);
});

test("american odds to cents", () => {
  assert.equal(Math.round(B.americanToCents(-150)), 60);
  assert.equal(Math.round(B.americanToCents("+150")), 40);
});
