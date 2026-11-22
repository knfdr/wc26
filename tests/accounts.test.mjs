// node --test tests/*.test.mjs
import test from "node:test";
import assert from "node:assert";
import { seal, unseal, saveKalshi, savedKalshi, kalshiEnvFor } from "../lib/accounts.js";

function fakeKV() {
  const m = new Map();
  return { m, get: async (k, t) => (m.has(k) ? (t === "json" ? JSON.parse(m.get(k)) : m.get(k)) : null), put: async (k, v) => m.set(k, v), delete: async (k) => m.delete(k) };
}
const site = () => ({ USERS: fakeKV(), USER_KEYS_SECRET: "test-secret-0123456789", KALSHI_API_KEY_ID: "OWNER-KEY", KALSHI_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----owner", KALSHI_TRADING_ENABLED: "1", KALSHI_MAX_ORDER_DOLLARS: "50" });
const owner = { email: "owner@example.test", role: "owner" }, friend = { email: "friend@example.test", role: "friend" };

test("sealed keys round-trip, can't be read with another secret or moved to another account", async () => {
  const env = site();
  const box = await seal(env, "a@example.test", { keyId: "k", privateKey: "p" });
  assert.ok(!JSON.stringify(box).includes("\"p\""));
  assert.deepEqual(await unseal(env, "a@example.test", box), { keyId: "k", privateKey: "p" });
  await assert.rejects(unseal(env, "b@example.test", box));
  await assert.rejects(unseal({ ...env, USER_KEYS_SECRET: "other-secret-0123456789" }, "a@example.test", box));
});

test("a friend never gets the owner's server key", async () => {
  const env = site();
  assert.equal(await kalshiEnvFor(env, friend), null);
  assert.equal(await kalshiEnvFor(env, { email: "x@example.test", role: null }), null);
  assert.equal(await kalshiEnvFor(env, null), null);
});

test("a friend's own key is used for them, with their own cap and the site kill switch", async () => {
  const env = site();
  await saveKalshi(env, friend.email, { keyId: "FRIEND-KEY", privateKey: "fpk", env: "demo", maxOrderDollars: 10 });
  const k = await kalshiEnvFor(env, friend);
  assert.equal(k.source, "own");
  assert.equal(k.KALSHI_API_KEY_ID, "FRIEND-KEY");
  assert.equal(k.KALSHI_ENV, "demo");
  assert.equal(k.KALSHI_MAX_ORDER_DOLLARS, "10");
  assert.equal(k.KALSHI_TRADING_ENABLED, "1");
  assert.equal(await kalshiEnvFor({ ...env, KALSHI_TRADING_ENABLED: undefined }, friend).then(x => x.KALSHI_TRADING_ENABLED), undefined);
  // stored encrypted
  assert.ok(![...env.USERS.m.values()].some(v => v.includes("fpk")));
});

test("owner: server key until they save their own, then their own", async () => {
  const env = site();
  const a = await kalshiEnvFor(env, owner);
  assert.equal(a.source, "site"); assert.equal(a.KALSHI_API_KEY_ID, "OWNER-KEY"); assert.equal(a.KALSHI_MAX_ORDER_DOLLARS, "50");
  await saveKalshi(env, owner.email, { keyId: "OWNER-OWN", privateKey: "opk", env: "prod", maxOrderDollars: 30 });
  const b = await kalshiEnvFor(env, owner);
  assert.equal(b.source, "own"); assert.equal(b.KALSHI_API_KEY_ID, "OWNER-OWN");
  assert.equal((await savedKalshi(env, friend.email)), null);
});

test("no storage configured: owner still uses the server key, friends get none", async () => {
  const env = { ...site(), USERS: undefined };
  assert.equal((await kalshiEnvFor(env, owner)).source, "site");
  assert.equal(await kalshiEnvFor(env, friend), null);
});
