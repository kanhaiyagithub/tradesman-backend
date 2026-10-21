const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const test = require("node:test");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
process.env.DUMMY_USERS_ENABLED = "true";
// The real limit is 10 (checked in its own tests); this suite creates more accounts than that overall.
const TEST_LIMIT = "100";
process.env.DUMMY_USERS_MAX = TEST_LIMIT;

const app = require("../app");
const sequelize = require("../config/db");
const storageConfig = require("../config/storage");
const storageService = require("../services/storage/storageService");
const Admin = require("../models/AdminModel/adminModel");
const User = require("../models/User");
const TradesmanDetails = require("../models/TradesmanDetails");
const TradesType = require("../models/tradesTypeModel");
const SubscriptionPlan = require("../models/SubscriptionPlan");
const UserSubscription = require("../models/UserSubscription");
const TravelPlan = require("../models/locationModel");
const ClientTradeAlert = require("../models/clientTradeAlertModel");
const TravelPlanAlertMatch = require("../models/travelPlanAlertMatchModel");
const Notification = require("../models/notificationModel");
const EmailNotificationLog = require("../models/EmailNotificationLog");
const { resetRateLimitBuckets } = require("../middlewares/rateLimitMiddleware");
const { hasSubscriptionAccess } = require("../services/subscriptionAccessService");
const { validateApprovalReadiness } = require("../controllers/tradesmanApprovalController");
const { createDummyUsers, parseCreateInput } = require("../services/dummyUserService");

const suffix = `${Date.now()}-${process.pid}`;
const TAG = `dum${Date.now().toString(36)}`;
const ADMIN_PASSWORD = "Password123!";
const AT = { latitude: -20.0, longitude: 120.0, label: `${TAG} Town` }; // far from any real data

let server;
let baseUrl;
let admin;
let token;
const extraTradeIds = [];
let trade; // throwaway, so matching can only involve this test's accounts
let tempPlan = null;
let realClient;
const createdIds = [];
const extraUserIds = [];

const call = async (method, urlPath, { body, as = token } = {}) => {
  resetRateLimitBuckets();
  const response = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: { "Content-Type": "application/json", ...(as ? { Authorization: `Bearer ${as}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed, headers: response.headers };
};

const create = async (fields = {}, { as } = {}) => {
  const response = await call("POST", "/api/admin/dummy-users", {
    as,
    body: { adminPassword: ADMIN_PASSWORD, tradeTypeId: trade.id, location: AT, runMatching: false, ...fields },
  });
  if (response.status === 201) createdIds.push(...response.body.data.created.map((u) => u.id));
  return response;
};

const dummyCount = () => User.count({ where: { isDummy: true } });

// MySQL may hand a JSON column back as text, so accept both.
const photoKeys = (details) =>
  typeof details.portfolioPhotos === "string" ? JSON.parse(details.portfolioPhotos) : details.portfolioPhotos || [];

const login = (email, password) =>
  call("POST", "/api/users/login", { as: null, body: { email, password } });

const fileExists = (key) => fs.existsSync(path.join(path.resolve(storageConfig.local.rootDir), key));

const dirFileCount = (folder) => {
  const dir = path.join(path.resolve(storageConfig.local.rootDir), folder);
  return fs.existsSync(dir) ? fs.readdirSync(dir).length : 0;
};

test.before(async () => {
  await sequelize.authenticate();
  assert.equal(await dummyCount(), 0, "start from a database without test users");

  admin = await Admin.create({
    name: "Dummy Admin",
    email: `dummy-admin-${suffix}@test.com`,
    password: await bcrypt.hash(ADMIN_PASSWORD, 10),
  });
  token = jwt.sign({ id: admin.id, role: "admin" }, process.env.JWT_SECRET, { expiresIn: "1h" });

  trade = await TradesType.create({ name: `${TAG} Trade`, category: "Test", isActive: true, licenceRequired: true });
  if ((await SubscriptionPlan.count()) === 0) {
    tempPlan = await SubscriptionPlan.create({ name: `${TAG} Plan`, priceMonthly: 5, stripePriceId: `price_${TAG}_${suffix}` });
  }

  realClient = await User.create({
    name: `${TAG} real client`,
    email: `${TAG}-real-${suffix}@test.com`,
    password: await bcrypt.hash("Password123!", 10),
    role: "client",
    isVerified: true,
  });
  extraUserIds.push(realClient.id);

  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));

  const ids = [...createdIds, ...extraUserIds];
  const details = await TradesmanDetails.findAll({ where: { userId: ids } });
  const users = await User.findAll({ where: { id: ids }, attributes: ["id", "profileImage"] });
  for (const item of details) {
    await storageService.deleteObject(item.licenseDocument, { category: "license" }).catch(() => {});
    await storageService.deleteObjects(photoKeys(item), { category: "portfolio" }).catch(() => {});
  }
  for (const user of users) {
    if (user.profileImage) await storageService.deleteObject(user.profileImage, { category: "profile" }).catch(() => {});
  }

  const alerts = await ClientTradeAlert.findAll({ where: { clientId: ids } });
  const alertIds = [...alerts.map((a) => a.id), ...(await ClientTradeAlert.findAll({ where: { tradeTypeId: trade.id } })).map((a) => a.id)];
  const matches = await TravelPlanAlertMatch.findAll({ where: { clientTradeAlertId: alertIds } });
  await EmailNotificationLog.destroy({ where: { matchId: matches.map((m) => m.id) } }).catch(() => {});
  await TravelPlanAlertMatch.destroy({ where: { clientTradeAlertId: alertIds } });
  await ClientTradeAlert.destroy({ where: { id: alertIds } });
  await TravelPlan.destroy({ where: { tradesmanId: ids } });
  await UserSubscription.destroy({ where: { userId: ids } });
  await Notification.destroy({ where: { userId: ids } });
  await TradesmanDetails.destroy({ where: { userId: ids } });
  await User.destroy({ where: { id: ids } });
  await TradesType.destroy({ where: { id: [trade.id, ...extraTradeIds] } });
  if (tempPlan) await SubscriptionPlan.destroy({ where: { id: tempPlan.id } });
  await Admin.destroy({ where: { id: admin.id } });
  await sequelize.close();
});

/* ---------- access, switch, confirmation ---------- */

test("every test-user endpoint needs an admin token", async () => {
  for (const [method, p] of [
    ["GET", "/api/admin/dummy-users/status"],
    ["GET", "/api/admin/dummy-users"],
    ["POST", "/api/admin/dummy-users"],
    ["POST", "/api/admin/dummy-users/1/password"],
  ]) {
    assert.equal((await call(method, p, { as: null })).status, 401, `${method} ${p}`);
  }
});

test("status reports the limits (default 10), and any admin can read it", async () => {
  delete process.env.DUMMY_USERS_MAX; // the built-in default
  try {
    const status = await call("GET", "/api/admin/dummy-users/status");
    assert.equal(status.status, 200);
    assert.deepEqual(status.body.data, { enabled: true, max: 10, count: 0, remaining: 10, emailDomain: "touringtrades.test" });
  } finally {
    process.env.DUMMY_USERS_MAX = TEST_LIMIT;
  }
});

test("the on/off switch stops creating test users, but status, the list and deleting stay available", async () => {
  process.env.DUMMY_USERS_ENABLED = "false";
  try {
    // Reading is always allowed, so test data left on a server can still be seen (and deleted, see the delete tests).
    assert.equal((await call("GET", "/api/admin/dummy-users")).status, 200);
    assert.equal((await create({ role: "client" })).status, 403);
    assert.equal((await call("POST", "/api/admin/dummy-users/1/password", { body: { adminPassword: ADMIN_PASSWORD } })).status, 403);

    const status = await call("GET", "/api/admin/dummy-users/status");
    assert.equal(status.status, 200);
    assert.equal(status.body.data.enabled, false);
  } finally {
    process.env.DUMMY_USERS_ENABLED = "true";
  }
  assert.equal(await dummyCount(), 0);
});

test("production needs the switch turned on explicitly", () => {
  const { isDummyUsersEnabled } = require("../config/dummyUsers");
  const saved = { flag: process.env.DUMMY_USERS_ENABLED, env: process.env.NODE_ENV };
  try {
    delete process.env.DUMMY_USERS_ENABLED;
    process.env.NODE_ENV = "production";
    assert.equal(isDummyUsersEnabled(), false);
    process.env.NODE_ENV = "development";
    assert.equal(isDummyUsersEnabled(), true);
    process.env.NODE_ENV = "production";
    process.env.DUMMY_USERS_ENABLED = "true";
    assert.equal(isDummyUsersEnabled(), true);
  } finally {
    process.env.DUMMY_USERS_ENABLED = saved.flag;
    if (saved.env === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = saved.env;
  }
});

test("creating needs the acting admin's own password, and nothing is created without it", async () => {
  const missing = await call("POST", "/api/admin/dummy-users", { body: { role: "client" } });
  assert.equal(missing.status, 400);
  assert.match(missing.body.message, /your password is required/i);

  const wrong = await call("POST", "/api/admin/dummy-users", { body: { role: "client", adminPassword: "nope-nope" } });
  assert.equal(wrong.status, 400);
  assert.match(wrong.body.message, /incorrect password/i);

  assert.equal(await dummyCount(), 0);
});

/* ---------- validation ---------- */

test("bad input is refused with a clear message and creates nothing", async () => {
  const bad = [
    [{ role: "admin" }, /role must be/],
    [{ role: "boss" }, /role must be/],
    [{}, /role must be/],
    [{ role: "client", count: 0 }, /count must be/],
    [{ role: "client", count: 1001 }, /count must be/],
    [{ role: "client", count: 1.5 }, /count must be/],
    [{ role: "client", count: "3" }, /count must be/],
    [{ role: "client", count: 2, name: "Same Name" }, /only be set when creating one/],
    [{ role: "client", count: 2, email: "a@b.com" }, /only be set when creating one/],
    [{ role: "client", email: "not-an-email" }, /valid email/],
    [{ role: "client", name: "A" }, /name must be/],
    [{ role: "client", password: "short" }, /password must be/],
    [{ role: "tradesman", approval: "maybe" }, /approval must be/],
    [{ role: "tradesman", subscription: "gold" }, /subscription must be/],
    [{ role: "tradesman", tradeTypeId: "abc" }, /tradeTypeId must be/],
    [{ role: "tradesman", tradeTypeId: 999999999 }, /Invalid tradeTypeId/],
    [{ role: "tradesman", location: { latitude: 95, longitude: 0 } }, /latitude/],
    [{ role: "tradesman", location: { latitude: 0, longitude: 200 } }, /longitude/],
  ];

  for (const [fields, pattern] of bad) {
    const response = await create(fields);
    assert.equal(response.status, 400, JSON.stringify(fields));
    assert.match(response.body.message, pattern, JSON.stringify(fields));
  }
  assert.equal(await dummyCount(), 0);
});

test("parseCreateInput fills in sensible defaults", () => {
  const input = parseCreateInput({ role: "tradesman" });
  assert.equal(input.count, 1);
  assert.equal(input.approval, "approved");
  assert.equal(input.subscription, "active");
  assert.equal(input.runMatching, true);
  assert.equal(input.createAlert, false);
  assert.equal(input.location.label, "Sydney NSW");
});

/* ---------- creating clients ---------- */

test("a test client is flagged, verified, on a mail-proof address, and can log in with the password shown", async () => {
  const response = await create({ role: "client" });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("cache-control"), "no-store", "the response carries a password");

  const [client] = response.body.data.created;
  assert.match(client.email, /^dummy\..+@touringtrades\.test$/);
  assert.ok(client.password.length >= 12);

  const row = await User.findByPk(client.id);
  assert.equal(row.isDummy, true);
  assert.equal(row.role, "client");
  assert.equal(row.isVerified, true);
  assert.notEqual(row.password, client.password, "the password is stored hashed");
  assert.equal(await bcrypt.compare(client.password, row.password), true);

  const loggedIn = await login(client.email, client.password);
  assert.equal(loggedIn.status, 200);
  assert.ok(loggedIn.body.data.token);
});

test("a custom name, email and password are used as given (a real inbox is allowed)", async () => {
  const email = `${TAG}-custom-${suffix}@gmail.com`;
  const response = await create({ role: "client", name: "Casey Tester", email, password: "MyOwnPass123" });
  assert.equal(response.status, 201);
  assert.equal(response.body.data.created[0].name, "Casey Tester");
  assert.equal(response.body.data.created[0].email, email);
  assert.equal((await login(email, "MyOwnPass123")).status, 200);

  const again = await create({ role: "client", email });
  assert.equal(again.status, 409, "the same email cannot be used twice");
  assert.match(again.body.message, /already exists/i);
});

test("a test client can get a trade alert, with a location", async () => {
  const response = await create({ role: "client", createAlert: true });
  const [client] = response.body.data.created;
  const alert = await ClientTradeAlert.findOne({ where: { clientId: client.id } });
  assert.ok(alert);
  assert.equal(alert.tradeTypeId, trade.id);
  assert.equal(alert.isActive, true);
  assert.equal(alert.latitude, AT.latitude);
});

/* ---------- creating tradesmen ---------- */

test("a test tradesman is a complete, approved, subscribed, visible tradesman with real files", async () => {
  const response = await create({ role: "tradesman" });
  assert.equal(response.status, 201);
  const [tradesman] = response.body.data.created;
  assert.equal(tradesman.approval, "approved");

  const user = await User.findByPk(tradesman.id);
  const details = await TradesmanDetails.findOne({ where: { userId: tradesman.id } });
  assert.equal(user.isDummy, true);
  assert.equal(user.isVerified, true);
  assert.equal(details.isApproved, true);
  assert.equal(details.verificationStatus, "approved");
  assert.equal(details.tradeTypeId, trade.id);
  assert.deepEqual(validateApprovalReadiness(details), [], "a complete profile, as real approval requires");

  // Labelled placeholder files exist on disk, one set per user.
  for (const key of [user.profileImage, details.licenseDocument, ...photoKeys(details)]) {
    assert.ok(fileExists(key), `${key} should exist`);
  }
  assert.ok(photoKeys(details).length >= 1);

  const subscription = await UserSubscription.findOne({ where: { userId: tradesman.id } });
  assert.equal(subscription.status, "active");
  assert.equal(subscription.stripeSubscriptionId, null, "never talks to Stripe");
  assert.equal(hasSubscriptionAccess(subscription), true);

  const plan = await TravelPlan.findOne({ where: { tradesmanId: tradesman.id } });
  assert.equal(plan.latitude, AT.latitude);
  assert.equal(plan.status, "running");

  assert.equal((await login(tradesman.email, tradesman.password)).status, 200);
});

test("a test tradesman is found by test clients only, never by real clients", async () => {
  const testClient = (await create({ role: "client" })).body.data.created[0];
  const testTradesman = (await create({ role: "tradesman", name: `${TAG} Visible Vic` })).body.data.created[0];

  const filter = (email, password) =>
    login(email, password).then((res) =>
      call("GET", `/api/users/tradesmen/filter?tradeTypeId=${trade.id}`, { as: res.body.data.token }),
    );

  const asTestClient = await filter(testClient.email, testClient.password);
  assert.equal(asTestClient.status, 200);
  assert.ok(JSON.stringify(asTestClient.body).includes("Visible Vic"), "a test client sees the test tradesman");

  const realToken = jwt.sign({ id: realClient.id, email: realClient.email, role: "client" }, process.env.JWT_SECRET);
  const asRealClient = await call("GET", `/api/users/tradesmen/filter?tradeTypeId=${trade.id}`, { as: realToken });
  assert.equal(asRealClient.status, 200);
  assert.ok(!JSON.stringify(asRealClient.body).includes("Visible Vic"), "a real client never sees it");
  assert.ok(testTradesman);
});

test("a pending tradesman waits in the approvals queue, flagged as a test, without raising the badge", async () => {
  const before = (await call("GET", "/api/admin/tradesmen/pending-count")).body.data.count;

  const response = await create({ role: "tradesman", approval: "pending", name: `${TAG} Pending Pat` });
  const [tradesman] = response.body.data.created;

  const user = await User.findByPk(tradesman.id);
  const details = await TradesmanDetails.findOne({ where: { userId: tradesman.id } });
  assert.equal(user.isVerified, false);
  assert.equal(details.isApproved, false);
  assert.equal(details.verificationStatus, "pending");
  assert.equal(details.approvedBy, null);

  const queue = await call("GET", `/api/admin/tradesmen/pending?search=${TAG}%20Pending&limit=50`);
  const row = queue.body.data.data.find((r) => r.userId === tradesman.id);
  assert.ok(row, "listed so the approve/reject flow can be tested");
  assert.equal(row.user.isDummy, true);

  assert.equal((await call("GET", "/api/admin/tradesmen/pending-count")).body.data.count, before, "badge unchanged");
});

test("subscription options: trial, expired and none behave as named", async () => {
  const sub = async (subscription) => {
    const { created } = (await create({ role: "tradesman", subscription })).body.data;
    return UserSubscription.findOne({ where: { userId: created[0].id } });
  };

  const trial = await sub("trial");
  assert.equal(trial.status, "trialing");
  assert.equal(hasSubscriptionAccess(trial), true);

  const expired = await sub("expired");
  assert.equal(expired.status, "canceled");
  assert.equal(hasSubscriptionAccess(expired), false);

  const none = await sub("none");
  assert.equal(none, null);
});

/* ---------- matching ---------- */

test("a test tradesman matches a test client's alert, and never a real client's", async () => {
  const realAlert = await ClientTradeAlert.create({
    clientId: realClient.id,
    tradeType: trade.name,
    tradeTypeId: trade.id,
    locationName: `${TAG} real alert`,
    latitude: AT.latitude,
    longitude: AT.longitude,
    radiusKm: 50,
    isActive: true,
  });

  const testClient = (await create({ role: "client", createAlert: true, runMatching: false })).body.data.created[0];
  const testTradesman = (await create({ role: "tradesman", runMatching: true })).body.data.created[0];

  // Other test clients with alerts at the same place (from earlier tests) may match too: that is fine.
  // What must never happen is a match with a real client.
  const matches = await TravelPlanAlertMatch.findAll({ where: { tradesmanId: testTradesman.id } });
  const matchedClientIds = matches.map((m) => m.clientId);
  assert.ok(matchedClientIds.includes(testClient.id), "the test client with an alert matches");
  assert.ok(!matchedClientIds.includes(realClient.id), "the real client never matches");
  const matchedUsers = await User.findAll({ where: { id: matchedClientIds }, attributes: ["id", "isDummy"] });
  assert.ok(matchedUsers.length > 0 && matchedUsers.every((u) => u.isDummy === true), "every match is a test user");
  assert.equal(await TravelPlanAlertMatch.count({ where: { clientTradeAlertId: realAlert.id } }), 0);
});

/* ---------- all or nothing ---------- */

test("if creation fails part-way, no user, row or file is left behind", async () => {
  const before = {
    users: await dummyCount(),
    profile: dirFileCount("profile"),
    license: dirFileCount("license"),
    portfolio: dirFileCount("portfolio"),
  };

  const originalCreate = TradesmanDetails.create;
  let calls = 0;
  TradesmanDetails.create = async (...args) => {
    calls += 1;
    if (calls === 2) throw new Error("simulated failure on the second tradesman");
    return originalCreate.apply(TradesmanDetails, args);
  };

  try {
    await assert.rejects(
      createDummyUsers({ adminId: admin.id, input: parseCreateInput({ role: "tradesman", count: 3, tradeTypeId: trade.id, runMatching: false, location: AT }) }),
      /simulated failure/,
    );
  } finally {
    TradesmanDetails.create = originalCreate;
  }

  assert.equal(await dummyCount(), before.users, "the first user was rolled back too");
  assert.equal(dirFileCount("profile"), before.profile);
  assert.equal(dirFileCount("license"), before.license);
  assert.equal(dirFileCount("portfolio"), before.portfolio);
});

/* ---------- listing, password reset ---------- */

test("the list shows only test users, never passwords, with the details a tester needs", async () => {
  const list = await call("GET", "/api/admin/dummy-users?limit=50");
  assert.equal(list.status, 200);
  assert.ok(list.body.data.length >= 3);
  assert.ok(list.body.data.every((u) => !("password" in u) && !("resetPasswordToken" in u)));
  assert.ok(!list.body.data.some((u) => u.id === realClient.id), "real users are never listed");
  assert.equal(list.body.meta.total, await dummyCount());
  assert.equal(list.body.meta.max, Number(TEST_LIMIT));

  const tradesmen = (await call("GET", "/api/admin/dummy-users?role=tradesman&limit=50")).body.data;
  assert.ok(tradesmen.length >= 1 && tradesmen.every((u) => u.role === "tradesman"));
  const withProfile = tradesmen.find((u) => u.subscription);
  assert.ok(withProfile.tradesman.businessName);
  assert.ok(withProfile.tradesman.travelPlans >= 1);

  const found = await call("GET", `/api/admin/dummy-users?search=${encodeURIComponent("Visible Vic")}`);
  assert.equal(found.body.data.length, 1);
  assert.equal((await call("GET", "/api/admin/dummy-users?role=boss")).status, 400);
});

test("a forgotten test password can be replaced (shown once), but never for a real user", async () => {
  const [user] = (await create({ role: "client" })).body.data.created;

  const wrong = await call("POST", `/api/admin/dummy-users/${user.id}/password`, { body: { adminPassword: "nope-nope" } });
  assert.equal(wrong.status, 400);
  assert.equal((await login(user.email, user.password)).status, 200, "unchanged by the failed attempt");

  const reset = await call("POST", `/api/admin/dummy-users/${user.id}/password`, { body: { adminPassword: ADMIN_PASSWORD } });
  assert.equal(reset.status, 200);
  assert.equal(reset.headers.get("cache-control"), "no-store");
  const fresh = reset.body.data.password;
  assert.notEqual(fresh, user.password);
  assert.equal((await login(user.email, fresh)).status, 200);
  assert.equal((await login(user.email, user.password)).status, 400, "the old password stops working");

  const chosen = await call("POST", `/api/admin/dummy-users/${user.id}/password`, { body: { adminPassword: ADMIN_PASSWORD, password: "Chosen-Pass-1" } });
  assert.equal(chosen.body.data.password, "Chosen-Pass-1");
  assert.equal((await call("POST", `/api/admin/dummy-users/${user.id}/password`, { body: { adminPassword: ADMIN_PASSWORD, password: "short" } })).status, 400);

  const real = await call("POST", `/api/admin/dummy-users/${realClient.id}/password`, { body: { adminPassword: ADMIN_PASSWORD } });
  assert.equal(real.status, 404, "a real user can never be touched through this endpoint");
  assert.equal(await bcrypt.compare("Password123!", (await User.findByPk(realClient.id)).password), true);
  assert.equal((await call("POST", "/api/admin/dummy-users/abc/password", { body: { adminPassword: ADMIN_PASSWORD } })).status, 400);
});

/* ---------- the limit ---------- */

test("the total number of test users is capped", async () => {
  const existing = await dummyCount();
  process.env.DUMMY_USERS_MAX = String(existing + 2);
  try {
    const tooMany = await create({ role: "client", count: 3 });
    assert.equal(tooMany.status, 409);
    assert.match(tooMany.body.message, new RegExp(`at most ${existing + 2} test users`));
    assert.equal(await dummyCount(), existing, "nothing was created");

    const ok = await create({ role: "client", count: 2 });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.data.remaining, 0);
    assert.equal(new Set(ok.body.data.created.map((u) => u.email)).size, 2, "each gets its own email");
    assert.equal(new Set(ok.body.data.created.map((u) => u.password)).size, 2, "and its own password");

    const full = await create({ role: "client" });
    assert.equal(full.status, 409);

    const status = await call("GET", "/api/admin/dummy-users/status");
    assert.equal(status.body.data.remaining, 0);
  } finally {
    process.env.DUMMY_USERS_MAX = TEST_LIMIT;
  }
});

test("the built-in limit is 10 test users in total", async () => {
  delete process.env.DUMMY_USERS_MAX;
  try {
    assert.equal(parseCreateInput({ role: "client", count: 10 }).count, 10);
    assert.throws(() => parseCreateInput({ role: "client", count: 11 }), /count must be a whole number from 1 to 10/);
    assert.equal((await call("GET", "/api/admin/dummy-users/status")).body.data.max, 10);
  } finally {
    process.env.DUMMY_USERS_MAX = TEST_LIMIT;
  }
});

test("test tradesmen follow the licence rules: licence data only where a licence is needed, review only where it exists", async () => {
  const plain = await TradesType.create({ name: `${TAG} No Licence`, category: "Test", isActive: true, licenceRequired: false });
  extraTradeIds.push(plain.id);

  // Licence-required trade, approved: licence data and the verified flag, like an admin-approved real account.
  const licensed = (await create({ role: "tradesman", approval: "approved" })).body.data.created[0];
  const licensedDetails = await TradesmanDetails.findOne({ where: { userId: licensed.id } });
  assert.ok(licensedDetails.licenseNumber && licensedDetails.licenseDocument && licensedDetails.licenseExpiry);
  assert.equal(licensedDetails.licenceVerified, true);
  assert.equal(licensedDetails.isApproved, true);

  // Unlicensed trade, approved: no licence data and nothing to verify.
  const free = (await create({ role: "tradesman", tradeTypeId: plain.id, approval: "approved" })).body.data.created[0];
  const freeDetails = await TradesmanDetails.findOne({ where: { userId: free.id } });
  assert.equal(freeDetails.licenseNumber, null);
  assert.equal(freeDetails.licenseDocument, null);
  assert.equal(freeDetails.licenseExpiry, null);
  assert.equal(freeDetails.licenceVerified, false);
  assert.equal(freeDetails.isApproved, true);
  assert.equal((await User.findByPk(free.id)).isVerified, true);

  // Waiting for review makes no sense where nobody reviews: refused with a clear message, nothing created.
  const before = await dummyCount();
  const refused = await create({ role: "tradesman", tradeTypeId: plain.id, approval: "pending" });
  assert.equal(refused.status, 400);
  assert.match(refused.body.message, /does not need a licence/);
  assert.equal(await dummyCount(), before);

  // Pending with a random trade picks one that needs a licence, so it really appears in the queue.
  const pending = (await create({ role: "tradesman", tradeTypeId: undefined, approval: "pending" })).body.data.created[0];
  const pendingDetails = await TradesmanDetails.findOne({ where: { userId: pending.id } });
  const pendingTrade = await TradesType.findByPk(pendingDetails.tradeTypeId);
  assert.equal(pendingTrade.licenceRequired, true);
  assert.equal(pendingDetails.licenceVerified, false);
  assert.equal(pendingDetails.verificationStatus, "pending");
});
