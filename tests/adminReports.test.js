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
const SubscriptionPlan = require("../models/SubscriptionPlan");
const UserSubscription = require("../models/UserSubscription");
const {
  escapeLike,
  parsePaging,
  buildUsersFilter,
  buildSubscriptionsFilter,
} = require("../services/adminReportQueries");

const suffix = `${Date.now()}-${process.pid}`;
const TAG = `rpt${Date.now().toString(36)}`; // unique search word for this run

let server;
let baseUrl;
let admin;
let token;
let planA;
let planB;
const userIds = [];
const subIds = [];

const call = async (path, { auth = true } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: auth ? { Authorization: `Bearer ${token}` } : {},
  });
  const text = await response.text();
  const isJson = (response.headers.get("content-type") || "").includes("json");
  return {
    status: response.status,
    body: isJson && text ? JSON.parse(text) : text,
    headers: response.headers,
  };
};

const makeUser = async (name, role, isVerified) => {
  const user = await User.create({
    name,
    email: `${TAG}-${userIds.length}-${suffix}@test.com`,
    mobile: "0411111111",
    password: await bcrypt.hash("Password123!", 10),
    role,
    provider: "manual",
    isVerified,
  });
  userIds.push(user.id);
  return user;
};

const makeSub = async (user, plan, status, currentPeriodEnd = null) => {
  const sub = await UserSubscription.create({ userId: user.id, planId: plan.id, status, currentPeriodEnd });
  subIds.push(sub.id);
  return sub;
};

test.before(async () => {
  await sequelize.authenticate();
  admin = await Admin.create({
    name: "Report Admin",
    email: `report-admin-${suffix}@test.com`,
    password: await bcrypt.hash("Password123!", 10),
  });
  token = jwt.sign({ id: admin.id, role: "admin" }, process.env.JWT_SECRET, { expiresIn: "1h" });

  // 5 users: names carry the TAG so we can search for exactly these rows.
  const u1 = await makeUser(`${TAG} Alice`, "client", true);
  const u2 = await makeUser(`${TAG} Bob`, "client", false);
  const u3 = await makeUser(`${TAG} Carol`, "tradesman", true);
  const u4 = await makeUser(`${TAG} Dan`, "tradesman", false);
  await makeUser(`${TAG} 100%_off =cmd`, "client", false); // wildcard chars + formula text

  planA = await SubscriptionPlan.create({ name: `${TAG} PlanA`, priceMonthly: 10, stripePriceId: `price_a_${suffix}` });
  planB = await SubscriptionPlan.create({ name: `${TAG} PlanB`, priceMonthly: 20, stripePriceId: `price_b_${suffix}` });

  await makeSub(u1, planA, "active", new Date("2030-01-01T00:00:00Z"));
  await makeSub(u2, planA, "canceled");
  await makeSub(u3, planB, "active", new Date("2031-02-02T00:00:00Z"));
  await makeSub(u4, planB, "past_due");

  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await UserSubscription.destroy({ where: { id: subIds } });
  await SubscriptionPlan.destroy({ where: { id: [planA.id, planB.id] } });
  await User.destroy({ where: { id: userIds } });
  await Admin.destroy({ where: { id: admin.id } });
  await sequelize.close();
});

/* ---------- pure helpers ---------- */

test("escapeLike makes % and _ literal", () => {
  assert.equal(escapeLike("100%_off"), "100\\%\\_off");
  assert.equal(escapeLike("a\\b"), "a\\\\b");
});

test("parsePaging is opt-in and clamps values", () => {
  assert.equal(parsePaging({}).paged, false);
  assert.deepEqual(parsePaging({ page: "3", limit: "25" }), { paged: true, page: 3, limit: 25, offset: 50 });
  assert.equal(parsePaging({ page: "0" }).page, 1);
  assert.equal(parsePaging({ page: "abc" }).page, 1);
  assert.equal(parsePaging({ limit: "9999" }).limit, 100);
  assert.equal(parsePaging({ limit: "-5" }).limit, 1);
});

test("filter builders validate their inputs", () => {
  assert.ok(buildUsersFilter({ role: "boss" }).error);
  assert.ok(buildUsersFilter({ verified: "maybe" }).error);
  assert.ok(buildSubscriptionsFilter({ status: "nope" }).error);
  assert.ok(buildSubscriptionsFilter({ planId: "x" }).error);
  assert.ok(buildSubscriptionsFilter({ planId: "-1" }).error);
  assert.equal(buildUsersFilter({ role: "client", verified: "true" }).error, undefined);
});

/* ---------- HTTP ---------- */

test("reports need an admin token", async () => {
  for (const path of [
    "/api/admin/reports/users",
    "/api/admin/reports/users/export",
    "/api/admin/reports/subscriptions",
    "/api/admin/reports/subscriptions/export",
  ]) {
    assert.equal((await call(path, { auth: false })).status, 401, path);
  }
});

test("users: paging returns a slice plus the total, newest first", async () => {
  const page1 = await call(`/api/admin/reports/users?search=${TAG}&page=1&limit=2`);
  assert.equal(page1.status, 200);
  assert.equal(page1.body.data.length, 2);
  assert.deepEqual(page1.body.meta, { total: 5, page: 1, perPage: 2 });

  const page3 = await call(`/api/admin/reports/users?search=${TAG}&page=3&limit=2`);
  assert.equal(page3.body.data.length, 1);

  const beyond = await call(`/api/admin/reports/users?search=${TAG}&page=9&limit=2`);
  assert.equal(beyond.body.data.length, 0);
  assert.equal(beyond.body.meta.total, 5);

  const times = page1.body.data.map((u) => new Date(u.createdAt).getTime());
  assert.ok(times[0] >= times[1], "newest first");
  assert.ok(page1.body.data.every((u) => !("password" in u)));
});

test("users: role, verified and search filters combine", async () => {
  const q = (extra) => call(`/api/admin/reports/users?search=${TAG}&page=1&limit=50${extra}`);

  assert.equal((await q("&role=tradesman")).body.meta.total, 2);
  assert.equal((await q("&role=client&verified=true")).body.meta.total, 1);
  assert.equal((await q("&verified=false")).body.meta.total, 3);
  assert.equal((await call(`/api/admin/reports/users?search=${TAG}%20carol&page=1`)).body.meta.total, 1);

  // % and _ are literal characters, not wildcards: "100%_off" finds only the user with that exact text,
  // and "<tag> %" finds nobody (as a wildcard it would have matched all 5 test users).
  assert.equal((await call(`/api/admin/reports/users?search=${encodeURIComponent("100%_off")}&page=1`)).body.meta.total, 1);
  assert.equal((await call(`/api/admin/reports/users?search=${encodeURIComponent(`${TAG} %`)}&page=1`)).body.meta.total, 0);
  assert.equal((await call(`/api/admin/reports/users?search=${encodeURIComponent("100_off")}&page=1`)).body.meta.total, 0);

  assert.equal((await q("&role=boss")).status, 400);
  assert.equal((await q("&verified=maybe")).status, 400);
});

test("users: without paging params the full list still comes back (old behaviour)", async () => {
  const all = await call(`/api/admin/reports/users?search=${TAG}`);
  assert.equal(all.status, 200);
  assert.equal(all.body.data.length, 5);
  assert.equal(all.body.meta, undefined);
});

test("users CSV exports exactly what the filters match, with formulas neutralised", async () => {
  const all = await call(`/api/admin/reports/users/export?search=${TAG}`);
  assert.equal(all.status, 200);
  assert.match(all.headers.get("content-type"), /text\/csv/);
  assert.match(all.headers.get("content-disposition"), /users\.csv/);
  const lines = all.body.trim().split("\n");
  assert.equal(lines.length, 1 + 5);
  assert.match(lines[0], /"id","name","email","role","isVerified","createdAt"/);

  const tradesmen = await call(`/api/admin/reports/users/export?search=${TAG}&role=tradesman`);
  assert.equal(tradesmen.body.trim().split("\n").length, 1 + 2);

  const empty = await call(`/api/admin/reports/users/export?search=${TAG}-no-such-user`);
  assert.equal(empty.status, 200);
  assert.equal(empty.body.trim().split("\n").length, 1, "an empty export is just the header row");

  assert.equal((await call("/api/admin/reports/users/export?role=boss")).status, 400);
});

test("subscriptions: paging, plan, status and search filters", async () => {
  const q = (extra) => call(`/api/admin/reports/subscriptions?search=${TAG}&page=1&limit=50${extra}`);

  const all = await q("");
  assert.equal(all.status, 200);
  assert.equal(all.body.meta.total, 4);
  assert.ok(all.body.data.every((s) => s.user?.name && s.plan?.name), "user and plan are included");
  assert.ok(all.body.data.every((s) => !("stripeCustomerId" in s) && !("stripeSubscriptionId" in s)));
  assert.ok(all.body.meta.plans.some((p) => p.id === planA.id), "plan options are provided");

  assert.equal((await q(`&planId=${planA.id}`)).body.meta.total, 2);
  assert.equal((await q("&status=active")).body.meta.total, 2);
  assert.equal((await q(`&planId=${planB.id}&status=past_due`)).body.meta.total, 1);

  // search reaches the joined user and plan tables
  assert.equal((await call(`/api/admin/reports/subscriptions?search=${TAG}%20carol&page=1`)).body.meta.total, 1);
  assert.equal((await call(`/api/admin/reports/subscriptions?search=${TAG}%20PlanB&page=1`)).body.meta.total, 2);

  const paged = await call(`/api/admin/reports/subscriptions?search=${TAG}&page=2&limit=3`);
  assert.equal(paged.body.data.length, 1);
  assert.equal(paged.body.meta.total, 4);

  assert.equal((await q("&status=nope")).status, 400);
  assert.equal((await q("&planId=abc")).status, 400);
});

test("subscriptions CSV follows the filters and includes the period end", async () => {
  const active = await call(`/api/admin/reports/subscriptions/export?search=${TAG}&status=active`);
  assert.equal(active.status, 200);
  const lines = active.body.trim().split("\n");
  assert.equal(lines.length, 1 + 2);
  assert.match(lines[0], /"user","email","plan","price","status","currentPeriodEnd"/);
  assert.ok(active.body.includes("2030-01-01T00:00:00.000Z"));

  const all = await call(`/api/admin/reports/subscriptions/export?search=${TAG}`);
  assert.equal(all.body.trim().split("\n").length, 1 + 4);

  const empty = await call(`/api/admin/reports/subscriptions/export?search=${TAG}-none`);
  assert.equal(empty.body.trim().split("\n").length, 1);
});
