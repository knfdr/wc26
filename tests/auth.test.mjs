// node --test tests/
import test from "node:test";
import assert from "node:assert";
import { generateKeyPairSync, createSign } from "node:crypto";
import { verifyAccessJwt, roleFor, ownerOnly, currentUser } from "../lib/auth.js";

const TEAM = "team.cloudflareaccess.com", AUD = "aud123";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1" };
const certs = async () => ({ ok: true, json: async () => ({ keys: [jwk] }) });
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
function sign(payload, { kid = "k1", key = privateKey } = {}) {
  const head = b64({ alg: "RS256", kid, typ: "JWT" }) + "." + b64(payload);
  return head + "." + createSign("RSA-SHA256").update(head).sign(key).toString("base64url");
}
const now = Math.floor(Date.now() / 1000);
const good = { aud: [AUD], iss: "https://" + TEAM, exp: now + 3600, iat: now, email: "Owner@Example.test" };
const opts = { team: TEAM, aud: AUD, fetchImpl: certs };

test("accepts a valid Access token", async () => {
  assert.equal((await verifyAccessJwt(sign(good), opts)).email, "Owner@Example.test");
});

test("rejects wrong audience, issuer, expired, forged, tampered, alg none", async () => {
  assert.equal(await verifyAccessJwt(sign({ ...good, aud: ["other"] }), opts), null);
  assert.equal(await verifyAccessJwt(sign({ ...good, iss: "https://evil.cloudflareaccess.com" }), opts), null);
  assert.equal(await verifyAccessJwt(sign({ ...good, exp: now - 10 }), opts), null);
  const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  assert.equal(await verifyAccessJwt(sign(good, { key: other }), opts), null);
  const [h, , s] = sign(good).split(".");
  assert.equal(await verifyAccessJwt([h, b64({ ...good, email: "friend@example.test" }), s].join("."), opts), null);
  assert.equal(await verifyAccessJwt(b64({ alg: "none", kid: "k1" }) + "." + b64(good) + ".", opts), null);
  assert.equal(await verifyAccessJwt(sign(good, { kid: "nope" }), opts), null);
  assert.equal(await verifyAccessJwt("garbage", opts), null);
});

test("roles: owner, friend, everyone else refused", () => {
  const env = { OWNER_EMAIL: "owner@example.test", FRIEND_EMAILS: "a@example.test, B@example.test" };
  assert.equal(roleFor(env, "OWNER@example.test"), "owner");
  assert.equal(roleFor(env, "b@example.test"), "friend");
  assert.equal(roleFor(env, "stranger@example.test"), null);
  assert.equal(roleFor({}, "owner@example.test"), null);
});

test("owner-only routes", () => {
  for (const [m, p] of [["GET", "/api/runner/status"], ["POST", "/api/runner/kill"], ["GET", "/api/runner"], ["PATCH", "/api/gist"]])
    assert.equal(ownerOnly(m, p), true, m + " " + p);
  // Kalshi routes are open to everyone but sign with each person's own key (see accounts tests)
  for (const [m, p] of [["POST", "/api/kx/portfolio/events/orders"], ["GET", "/api/kx/portfolio/balance"], ["GET", "/api/kx-ws"], ["POST", "/api/kalshi"], ["GET", "/api/kx/markets/KXABC"], ["GET", "/api/kx/_status"], ["GET", "/api/gist"], ["GET", "/api/kalshi"], ["GET", "/api/resolve"], ["GET", "/index.html"], ["GET", "/live.html"]])
    assert.equal(ownerOnly(m, p), false, m + " " + p);
});

test("currentUser: token required in production; dev cookie only on localhost without ACCESS_AUD", async () => {
  const env = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, OWNER_EMAIL: "owner@example.test" };
  const req = (url, headers = {}) => new Request(url, { headers });
  assert.deepEqual(await currentUser(req("https://x.pages.dev/", { "Cf-Access-Jwt-Assertion": sign(good) }), env, certs), { email: "owner@example.test", role: "owner" });
  assert.deepEqual(await currentUser(req("https://x.pages.dev/", { Cookie: "CF_Authorization=" + sign(good) }), env, certs), { email: "owner@example.test", role: "owner" });
  assert.equal(await currentUser(req("https://x.pages.dev/", { Cookie: "dev-email=owner@example.test" }), env, certs), null);
  assert.equal(await currentUser(req("http://localhost:8788/", { Cookie: "dev-email=owner@example.test" }), env, certs), null); // ACCESS_AUD set: no dev bypass
  assert.equal(await currentUser(req("https://x.pages.dev/", { Cookie: "dev-email=owner@example.test" }), { OWNER_EMAIL: "owner@example.test" }, certs), null);
  assert.deepEqual(await currentUser(req("http://localhost:8788/", { Cookie: "dev-email=owner@example.test" }), { OWNER_EMAIL: "owner@example.test" }, certs), { email: "owner@example.test", role: "owner" });
});
