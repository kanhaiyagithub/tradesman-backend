const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";

const app = require("../app");
const sequelize = require("../config/db");
const Admin = require("../models/AdminModel/adminModel");
const User = require("../models/User");
const TradesmanDetails = require("../models/TradesmanDetails");
const TradesType = require("../models/tradesTypeModel");
const SubscriptionPlan = require("../models/SubscriptionPlan");
const UserSubscription = require("../models/UserSubscription");
const { parseDummyMode } = require("../services/adminReportQueries");

const suffix = `${Date.now()}-${process.pid}`;
const TAG = `dmy${Date.now().toString(36)}`;
const PRICE = 37; // distinctive so revenue changes are easy to see

let server;
let baseUrl;
let admin;
let token;
let plan;
let trade;
const userIds = [];
const subIds = [];

const call = async (path) => {
  const response = await fetch(`${baseUrl}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const text = await response.text();
  const isJson = (response.headers.get("content-type") || "").includes("json");
  return { status: response.status, body: isJson && text ? JSON.parse(text) : text };
};

const summary = async () => (await call("/api/admin/dashboard/summary")).body.data;
const pendingCount = async () => (await call("/api/admin/tradesmen/pending-count")).body.data.count;

const makeUser = async ({ label, role, isDummy }) => {
  const user = await User.create({
    name: `${TAG} ${label}`,
    email: `${TAG}-${label}-${suffix}@test.com`,
    mobile: "0411111111",
    password: await bcrypt.hash("Password123!", 10),
    role,
    provider: "manual",
    isVerified: true,
    isDummy,
  });
  userIds.push(user.id);
  return user;
};

// A tradesman waiting for review who also has a paying (active) subscription.
const makeSubscribedPendingTradesman = async (label, isDummy) => {
  const user = await makeUser({ label, role: "tradesman", isDummy });
  await TradesmanDetails.create({
    userId: user.id,
    tradeType: trade.name,
    tradeTypeId: trade.id,
    businessName: `${TAG} ${label} Co`,
    licenseNumber: "L-1",
    licenseExpiry: new Date("2031-01-01"),
    licenseDocument: "license/none.png",
    isApproved: false,
    verificationStatus: "pending",
  });
  const sub = await UserSubscription.create({
    userId: user.id,
    planId: plan.id,
    status: "active",
    currentPeriodEnd: new Date(Date.now() + 30 * 24 * 3600 * 1000),
  });
  subIds.push(sub.id);
  return user;
};

test.before(async () => {
  await sequelize.authenticate();
  trade = await TradesType.findOne();
  assert.ok(trade, "a trade type seed is required");

  admin = await Admin.create({
    name: "Dummy Stats Admin",
    email: `dummy-stats-admin-${suffix}@test.com`,
    password: await bcrypt.hash("Password123!", 10),
  });
  token = jwt.sign({ id: admin.id, role: "admin" }, process.env.JWT_SECRET, { expiresIn: "1h" });

  plan = await SubscriptionPlan.create({
    name: `${TAG} Plan`,
    priceMonthly: PRICE,
    stripePriceId: `price_${TAG}_${suffix}`,
  });

  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await UserSubscription.destroy({ where: { id: subIds } });
  await TradesmanDetails.destroy({ where: { userId: userIds } });
  await User.destroy({ where: { id: userIds } });
  await SubscriptionPlan.destroy({ where: { id: plan.id } });
  await Admin.destroy({ where: { id: admin.id } });
  await sequelize.close();
});

test("new users are real by default", async () => {
  const user = await User.create({
    name: `${TAG} default`,
    email: `${TAG}-default-${suffix}@test.com`,
    password: "x",
  });
  userIds.push(user.id);
  assert.equal(user.isDummy, false);
});

test("the dummy filter accepts exclude (default), include and only", () => {
  assert.deepEqual(parseDummyMode({}), { value: false });
  assert.deepEqual(parseDummyMode({ dummy: "" }), { value: false });
  assert.deepEqual(parseDummyMode({ dummy: "exclude" }), { value: false });
  assert.deepEqual(parseDummyMode({ dummy: "only" }), { value: true });
  assert.deepEqual(parseDummyMode({ dummy: "include" }), { value: undefined });
  assert.match(parseDummyMode({ dummy: "maybe" }).error, /dummy must be one of/);
});

test("test users and their subscriptions never change Overview, but real ones do", async () => {
  const before = await summary();
  const pendingBefore = await pendingCount();

  // A full set of test accounts: a client, and a subscribed tradesman waiting for review.
  await makeUser({ label: "dummy-client", role: "client", isDummy: true });
  await makeSubscribedPendingTradesman("dummy-tradesman", true);

  const afterDummies = await summary();
  assert.deepEqual(afterDummies.users, before.users, "user counts ignore test users");
  assert.deepEqual(afterDummies.tradesmen, before.tradesmen, "tradesman counts and pending approvals ignore test users");
  assert.deepEqual(afterDummies.subscriptions, before.subscriptions, "subscription counts ignore test users");
  assert.deepEqual(afterDummies.revenue, before.revenue, "revenue ignores test subscriptions");
  assert.deepEqual(afterDummies.signups, before.signups, "signups ignore test users");
  assert.equal(await pendingCount(), pendingBefore, "the sidebar badge ignores test tradesmen");

  // Control: the same accounts as REAL users must show up, so the checks above can fail.
  await makeUser({ label: "real-client", role: "client", isDummy: false });
  await makeSubscribedPendingTradesman("real-tradesman", false);

  const afterReal = await summary();
  assert.equal(afterReal.users.total, before.users.total + 2);
  assert.equal(afterReal.users.clients, before.users.clients + 1);
  assert.equal(afterReal.users.tradesmen, before.users.tradesmen + 1);
  assert.equal(afterReal.tradesmen.pendingApprovals, before.tradesmen.pendingApprovals + 1);
  assert.equal(afterReal.subscriptions.active, before.subscriptions.active + 1);
  assert.equal(afterReal.revenue.monthlyRecurring, before.revenue.monthlyRecurring + PRICE);
  assert.equal(await pendingCount(), pendingBefore + 1);
});

test("the legacy overview and analytics endpoints also ignore test users", async () => {
  const overviewBefore = (await call("/api/admin/dashboard/overview")).body.data;
  await makeUser({ label: "legacy-dummy", role: "client", isDummy: true });
  const overviewAfter = (await call("/api/admin/dashboard/overview")).body.data;
  assert.deepEqual(overviewAfter, overviewBefore);

  const analytics = await call("/api/admin/dashboard/analytics");
  assert.equal(analytics.status, 200);
});

test("users report hides test users by default and can include or isolate them", async () => {
  const q = (extra = "") => call(`/api/admin/reports/users?search=${TAG}&page=1&limit=50${extra}`);
  const names = (res) => res.body.data.map((u) => u.name.replace(`${TAG} `, "")).sort();

  const byDefault = await q();
  // ("default" is the real user created by the first test in this file.)
  assert.deepEqual(names(byDefault), ["default", "real-client", "real-tradesman"]);

  const included = await q("&dummy=include");
  assert.ok(["dummy-client", "dummy-tradesman", "real-client", "real-tradesman"].every((n) => names(included).includes(n)));
  assert.equal(included.body.data.find((u) => u.name.endsWith("dummy-client")).isDummy, true);
  assert.equal(included.body.data.find((u) => u.name.endsWith("real-client")).isDummy, false);

  const only = await q("&dummy=only");
  assert.ok(only.body.data.length >= 2);
  assert.ok(only.body.data.every((u) => u.isDummy === true));

  assert.equal((await q("&dummy=nope")).status, 400);
});

test("users CSV follows the dummy filter and shows the flag", async () => {
  const normal = await call(`/api/admin/reports/users/export?search=${TAG}`);
  assert.equal(normal.status, 200);
  assert.ok(!normal.body.includes("dummy-client"));
  assert.match(normal.body.split("\n")[0], /"isDummy"/);

  const onlyTest = await call(`/api/admin/reports/users/export?search=${TAG}&dummy=only`);
  assert.ok(onlyTest.body.includes("dummy-client"));
  assert.ok(!onlyTest.body.includes("real-client"));
});

test("subscriptions report and CSV follow the dummy filter too", async () => {
  const q = (extra = "") => call(`/api/admin/reports/subscriptions?search=${TAG}&page=1&limit=50${extra}`);

  const byDefault = await q();
  assert.ok(byDefault.body.data.length >= 1);
  assert.ok(byDefault.body.data.every((s) => s.user.isDummy === false));

  const only = await q("&dummy=only");
  assert.ok(only.body.data.length >= 1);
  assert.ok(only.body.data.every((s) => s.user.isDummy === true));

  const included = await q("&dummy=include");
  assert.equal(included.body.meta.total, byDefault.body.meta.total + only.body.meta.total);

  assert.equal((await q("&dummy=nope")).status, 400);

  const csv = await call(`/api/admin/reports/subscriptions/export?search=${TAG}&dummy=only`);
  assert.match(csv.body.split("\n")[0], /"isDummy"/);
  assert.ok(csv.body.includes("dummy-tradesman"));
});

test("the approvals queue still lists a subscribed test tradesman, flagged as a test", async () => {
  const response = await call(`/api/admin/tradesmen/pending?search=${TAG}&limit=50`);
  assert.equal(response.status, 200);

  const rows = response.body.data.data;
  const dummy = rows.find((r) => r.user.name.endsWith("dummy-tradesman"));
  const real = rows.find((r) => r.user.name.endsWith("real-tradesman"));
  assert.ok(dummy, "test tradesmen appear in the queue so the approval flow can be tested");
  assert.equal(dummy.user.isDummy, true);
  assert.equal(real.user.isDummy, false);

  const one = await call(`/api/admin/tradesmen/${dummy.userId}`);
  assert.equal(one.body.data.user.isDummy, true);
});
