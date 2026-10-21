const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";

const app = require("../app");
const sequelize = require("../config/db");
const User = require("../models/User");
const TradesmanDetails = require("../models/TradesmanDetails");
const TradesType = require("../models/tradesTypeModel");

const suffix = `${Date.now()}-${process.pid}`;
const TAG = `ps${Date.now().toString(36)}`;

let server;
let baseUrl;
let licensed;
let plain;
let viewerToken;
const userIds = [];
const tradeIds = [];
const people = {};

const get = async (path, token) => {
  const response = await fetch(`${baseUrl}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  return { status: response.status, body: await response.json() };
};
const post = async (path, body, token) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
};

const make = async (label, trade, details = {}) => {
  const user = await User.create({
    name: `${TAG} ${label}`,
    email: `${TAG}-${label}-${suffix}@test.com`,
    mobile: "0411111111",
    password: await bcrypt.hash("Password123!", 10),
    role: "tradesman",
    provider: "manual",
    isVerified: true,
  });
  userIds.push(user.id);
  await TradesmanDetails.create({
    userId: user.id,
    tradeType: trade.name,
    tradeTypeId: trade.id,
    businessName: `${TAG} ${label} Co`,
    shortBio: "bio",
    isApproved: true,
    verificationStatus: "approved",
    licenseNumber: "SECRET-NUMBER-123",
    licenseDocument: "license/secret.png",
    portfolioPhotos: ["portfolio/work-1.jpg", "portfolio/work-2.jpg"],
    licenseExpiry: new Date("2035-01-01"),
    ...details,
  });
  people[label] = user;
  return user;
};

test.before(async () => {
  licensed = await TradesType.create({ name: `${TAG} Licensed`, category: `${TAG} Cat`, isActive: true, licenceRequired: true, licenceLabel: `${TAG} licence (QBCC)` });
  plain = await TradesType.create({ name: `${TAG} Plain`, category: `${TAG} Cat`, isActive: true });
  tradeIds.push(licensed.id, plain.id);

  await make("verified", licensed, { licenceVerified: true });
  await make("unverified", licensed, { licenceVerified: false });
  await make("expired", licensed, { licenceVerified: true, licenseExpiry: new Date("2020-01-01") });
  await make("plain", plain);

  const viewer = await User.create({
    name: `${TAG} Viewer`,
    email: `${TAG}-viewer-${suffix}@test.com`,
    mobile: "0411111111",
    password: await bcrypt.hash("Password123!", 10),
    role: "client",
    provider: "manual",
  });
  userIds.push(viewer.id);
  viewerToken = jwt.sign({ id: viewer.id, email: viewer.email, role: "client" }, process.env.JWT_SECRET);

  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await TradesmanDetails.destroy({ where: { userId: userIds } });
  await User.destroy({ where: { id: userIds } });
  await TradesType.destroy({ where: { id: tradeIds } });
  await new Promise((resolve) => server.close(resolve));
  await sequelize.close();
});

const licenceOf = (row) => ({
  required: row.licenceRequired,
  label: row.licenceLabel,
  verified: row.licenceVerified,
});

test("public profile shows licence facts, and an expired licence loses its badge", async () => {
  const verified = (await get(`/api/users/${people.verified.id}`)).body.data;
  assert.deepEqual(licenceOf(verified), { required: true, label: `${TAG} licence (QBCC)`, verified: true });
  assert.equal(verified.isVerified, true, "isVerified now means licence verified");

  const unverified = (await get(`/api/users/${people.unverified.id}`)).body.data;
  assert.equal(unverified.licenceVerified, false);

  const expired = (await get(`/api/users/${people.expired.id}`)).body.data;
  assert.equal(expired.licenceVerified, false, "expired licence: no badge");
  assert.equal(expired.isVerified, false, "no tick when expired");
  const listed = (await get(`/api/users/tradesmen?tradeTypeId=${licensed.id}&limit=50`)).body.data;
  assert.ok(listed.some((item) => item.id === people.expired.id), "but still listed");

  const unlicensedTick = (await get(`/api/users/${people.plain.id}`)).body.data;
  assert.equal(unlicensedTick.isVerified, false, "a no-licence trade is listed but never ticked");

  const plainPerson = (await get(`/api/users/${people.plain.id}`)).body.data;
  assert.deepEqual(licenceOf(plainPerson), { required: false, label: null, verified: false });
});

test("licence number, expiry and document are never exposed publicly", async () => {
  const endpoints = [
    `/api/users/${people.verified.id}`,
    `/api/users/profile/${people.verified.id}`,
    `/api/users/tradesmen?tradeTypeId=${licensed.id}`,
  ];
  for (const path of endpoints) {
    const text = JSON.stringify((await get(path)).body);
    assert.ok(!text.includes("SECRET-NUMBER-123"), path);
    assert.ok(!text.includes("secret.png"), path);
    assert.ok(!text.includes("2035-01-01"), path);
  }
});

test("the full profile includes the work photos as loadable URLs", async () => {
  const full = (await get(`/api/users/profile/${people.verified.id}`)).body.data;
  assert.equal(full.portfolioPhotos.length, 2);
  assert.ok(full.portfolioPhotos.every((url) => url.includes("portfolio/work-")), JSON.stringify(full.portfolioPhotos));
});

test("lists and the full profile carry the same licence fields", async () => {
  const list = (await get(`/api/users/tradesmen?tradeTypeId=${licensed.id}&limit=50`)).body.data;
  const row = list.find((item) => item.id === people.verified.id);
  assert.equal(row.licenceVerified, true);
  assert.equal(row.licenceRequired, true);

  const full = (await get(`/api/users/profile/${people.verified.id}`)).body.data;
  assert.deepEqual(licenceOf(full), { required: true, label: `${TAG} licence (QBCC)`, verified: true });

});

test("licenceVerifiedOnly narrows the filter; the plain filter still lists every approved person", async () => {
  const idsOf = (body) => {
    const data = body.data;
    const rows = Array.isArray(data) ? data : data.tradesmen || data.items || data.data || data.results || [];
    return rows.map((t) => t.id);
  };

  const all = idsOf((await get(`/api/users/tradesmen/filter?tradeTypeId=${licensed.id}`, viewerToken)).body);
  assert.ok(all.includes(people.verified.id));
  assert.ok(all.includes(people.unverified.id), "old behaviour: approved people are all listed");

  const onlyBody = (await get(`/api/users/tradesmen/filter?tradeTypeId=${licensed.id}&licenceVerifiedOnly=true`, viewerToken)).body;
  const only = idsOf(onlyBody);
  assert.ok(only.includes(people.verified.id));
  assert.ok(!only.includes(people.unverified.id));
});

test("/api/trades tells the app which trades need a licence", async () => {
  const trades = (await get("/api/trades")).body.data;
  const a = trades.find((t) => t.id === licensed.id);
  const b = trades.find((t) => t.id === plain.id);
  assert.equal(a.licenceRequired, true);
  assert.equal(a.licenceLabel, `${TAG} licence (QBCC)`);
  assert.equal(b.licenceRequired, false);
});

test("/me shows the owner's own licence state", async () => {
  const token = jwt.sign({ id: people.verified.id, email: people.verified.email, role: "tradesman" }, process.env.JWT_SECRET);
  const me = (await get("/api/users/me", token)).body.data;
  assert.equal(me.licenceRequired, true);
  assert.equal(me.licenceVerified, true);
  assert.equal(me.licenceLabel, `${TAG} licence (QBCC)`);
});
