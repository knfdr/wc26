// node --test tests/
import test from "node:test";
import assert from "node:assert";
import { generateKeyPairSync, verify, constants } from "node:crypto";
import { signedHeaders, checkOrder } from "../lib/kalshi.js";

test("signs with an RSA PKCS#1 key (RSA-PSS SHA-256, salt 32) over ts+METHOD+path without query", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs1", format: "pem" });
  assert.match(pem, /BEGIN RSA PRIVATE KEY/);
  const env = { KALSHI_API_KEY_ID: "kid", KALSHI_PRIVATE_KEY: pem.replace(/\n/g, "\\n") };
  const h = await signedHeaders(env, "get", "/trade-api/v2/portfolio/orders?limit=5");
  const msg = h["KALSHI-ACCESS-TIMESTAMP"] + "GET/trade-api/v2/portfolio/orders";
  const ok = verify("sha256", Buffer.from(msg), { key: publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, Buffer.from(h["KALSHI-ACCESS-SIGNATURE"], "base64"));
  assert.ok(ok);
  assert.equal(h["KALSHI-ACCESS-KEY"], "kid");
});

test("signs with an Ed25519 PKCS#8 key", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const env = { KALSHI_API_KEY_ID: "kid2", KALSHI_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }) };
  const h = await signedHeaders(env, "POST", "/trade-api/v2/portfolio/events/orders");
  const ok = verify(null, Buffer.from(h["KALSHI-ACCESS-TIMESTAMP"] + "POST/trade-api/v2/portfolio/events/orders"), publicKey, Buffer.from(h["KALSHI-ACCESS-SIGNATURE"], "base64"));
  assert.ok(ok);
});

test("order guard: kill switch, cap, and reduce_only exemption", () => {
  const o = { ticker: "KXNCAAFGAME-26NOV21LSUTENN-LSU", side: "bid", count: "100", price: "0.40", time_in_force: "immediate_or_cancel" };
  assert.match(checkOrder({}, o), /disabled/);
  const env = { KALSHI_TRADING_ENABLED: "1", KALSHI_MAX_ORDER_DOLLARS: "25" };
  assert.match(checkOrder(env, o), /exceeds/);                 // $40 > $25
  assert.equal(checkOrder(env, { ...o, count: "50" }), null);   // $20
  assert.match(checkOrder(env, { ...o, side: "ask", count: "50" }), /exceeds/); // buying NO at 0.60 = $30
  assert.equal(checkOrder(env, { ...o, side: "ask", reduce_only: true }), null);
  assert.match(checkOrder(env, { ...o, ticker: "../x" }), /ticker/);
});
