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
const Notification = require("../models/notificationModel");
const EmailNotificationLog = require("../models/EmailNotificationLog");
const { autoApproveIfUnlicensed, sanitizeLabel } = require("../services/tradeLicenceService");

const suffix = `${Date.now()}-${process.pid}`;
const TAG = `tl${Date.now().toString(36)}`;

let server;
let baseUrl;
let admin;
let token;
let plan;
const userIds = [];
const tradeIds = [];

const call = async (method, path, { body, as = token } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
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
  return { status: response.status, body: parsed };
};

const createTrade = async (label, fields = {}) => {
  const response = await call("POST", "/api/admin/trades", { body: { name: `${TAG} ${label}`, category: `${TAG} Cat`, ...fields } });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  tradeIds.push(response.body.data.id);
  return response.body.data;
};

const makeTradesman = async (label, trade, overrides = {}, { dummy = false, subscription = null } = {}) => {
  const user = await User.create({
    name: `${TAG} ${label}`,
    email: `${TAG}-${label}-${suffix}@test.com`,
    mobile: "0411111111",
    password: await bcrypt.hash("Password123!", 10),
    role: "tradesman",
    provider: "manual",
    isDummy: dummy,
    isVerified: Boolean(overrides.isApproved),
    profileImage: "profile/some.png",
  });
  userIds.push(user.id);
  const details = await TradesmanDetails.create({
    userId: user.id,
    tradeType: trade.name,
    tradeTypeId: trade.id,
    businessName: `${TAG} ${label} Co`,
    shortBio: "Test bio",
    licenseNumber: "L-123",
    licenseExpiry: new Date("2031-01-01"),
    licenseDocument: "license/some.png",
    ...overrides,
  });
  if (subscription) {
    await UserSubscription.create({
      userId: user.id,
      planId: plan.id,
      status: subscription,
      currentPeriodEnd: new Date(Date.now() + 30 * 864e5),
    });
  }
  return { user, details };
};

const state = async (userId) => {
  const details = await TradesmanDetails.findOne({ where: { userId } });
  const user = await User.findByPk(userId);
  return {
    status: details.verificationStatus,
    approved: details.isApproved,
    licenceVerified: details.licenceVerified,
    userVerified: user.isVerified,
    approvedBy: details.approvedBy,
    reason: details.rejectionReason,
  };
};

test.before(async () => {
  await sequelize.authenticate();
  admin = await Admin.create({
    name: "Trade Licence Admin",
    email: `trade-licence-admin-${suffix}@test.com`,
    password: await bcrypt.hash("Password123!", 10),
  });
  token = jwt.sign({ id: admin.id, role: "admin" }, process.env.JWT_SECRET, { expiresIn: "1h" });
  plan = await SubscriptionPlan.create({ name: `${TAG} Plan`, priceMonthly: 9, stripePriceId: `price_${TAG}_${suffix}` });

  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await EmailNotificationLog.destroy({ where: { recipientUserId: userIds } });
  await Notification.destroy({ where: { userId: userIds } });
  await UserSubscription.destroy({ where: { userId: userIds } });
  await TradesmanDetails.destroy({ where: { userId: userIds } });
  await User.destroy({ where: { id: userIds } });
  await TradesType.destroy({ where: { id: tradeIds } });
  await SubscriptionPlan.destroy({ where: { id: plan.id } });
  await Admin.destroy({ where: { id: admin.id } });
  await sequelize.close();
});

/* ---------- access and validation ---------- */

test("the new trade endpoints need an admin token", async () => {
  assert.equal((await call("PATCH", "/api/admin/trades/1", { as: null, body: { isActive: true } })).status, 401);
  assert.equal((await call("GET", "/api/admin/trades/1/licence-impact", { as: null })).status, 401);
});

test("sanitizeLabel strips tags and control characters and tidies spaces", () => {
  assert.equal(sanitizeLabel("  Plumbing   licence  "), "Plumbing licence");
  assert.equal(sanitizeLabel("<b>Plumbing</b> <script>x</script>licence"), "Plumbing xlicence");
  assert.equal(sanitizeLabel("Gas\u0000 fit\u0007ting\tlicence\n"), "Gas fitting licence");
  assert.equal(sanitizeLabel("   "), null);
  assert.equal(sanitizeLabel(null), null);
  assert.equal(sanitizeLabel(undefined), null);
});

test("creating a trade can set the licence requirement, with a default label", async () => {
  const withLabel = await createTrade("Created A", { licenceRequired: true, licenceLabel: "  Custom <i>licence</i> wording " });
  assert.equal(withLabel.licenceRequired, true);
  assert.equal(withLabel.licenceLabel, "Custom licence wording");

  const defaulted = await createTrade("Created B", { licenceRequired: true });
  assert.equal(defaulted.licenceLabel, `${TAG} Created B licence`);

  const plain = await createTrade("Created C");
  assert.equal(plain.licenceRequired, false);
  assert.equal(plain.licenceLabel, null);

  for (const body of [{ licenceRequired: "yes" }, { licenceRequired: 1 }, { licenceLabel: 5 }, { licenceLabel: "x".repeat(121) }]) {
    const bad = await call("POST", "/api/admin/trades", { body: { name: `${TAG} Bad`, category: "X", ...body } });
    assert.equal(bad.status, 400, JSON.stringify(body));
  }
});

test("updating validates ids, bodies and values", async () => {
  const trade = await createTrade("Validate");
  const patch = (id, body) => call("PATCH", `/api/admin/trades/${id}`, { body });

  assert.equal((await patch("abc", { isActive: true })).status, 400);
  assert.equal((await patch(999999999, { isActive: true })).status, 404);
  assert.equal((await patch(trade.id, {})).status, 400);
  assert.equal((await patch(trade.id, { unknownField: 1 })).status, 400);
  assert.equal((await patch(trade.id, { name: "   " })).status, 400);
  assert.equal((await patch(trade.id, { category: "" })).status, 400);
  assert.equal((await patch(trade.id, { isActive: "yes" })).status, 400);
  assert.equal((await patch(trade.id, { licenceRequired: "true" })).status, 400);
  assert.equal((await patch(trade.id, { licenceLabel: "x".repeat(121) })).status, 400);
  assert.equal((await patch(trade.id, { applyToExisting: "yes" })).status, 400);
  assert.equal((await patch(trade.id, { applyToExisting: true })).status, 400, "needs the trade to require a licence");

  const unchanged = await TradesType.findByPk(trade.id);
  assert.equal(unchanged.licenceRequired, false);
  assert.equal(unchanged.name, trade.name);
});

test("renaming updates the trade name copied onto profiles, and clashes are refused", async () => {
  const trade = await createTrade("Rename Me");
  const other = await createTrade("Other Name");
  const { user } = await makeTradesman("renamed", trade);

  const clash = await call("PATCH", `/api/admin/trades/${trade.id}`, { body: { name: other.name, category: other.category } });
  assert.equal(clash.status, 409);

  const renamed = await call("PATCH", `/api/admin/trades/${trade.id}`, { body: { name: `  ${TAG}   Renamed   Trade ` } });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.data.trade.name, `${TAG} Renamed Trade`);
  assert.equal((await TradesmanDetails.findOne({ where: { userId: user.id } })).tradeType, `${TAG} Renamed Trade`);

  const moved = await call("PATCH", `/api/admin/trades/${trade.id}`, { body: { category: `${TAG} Elsewhere`, isActive: false } });
  assert.equal(moved.body.data.trade.category, `${TAG} Elsewhere`);
  assert.equal(moved.body.data.trade.isActive, false);
});

/* ---------- turning a licence requirement on and off ---------- */

test("impact counts, turning ON (without and with 'ask existing'), repeating it, then turning OFF", async () => {
  const trade = await createTrade("Switch");
  const other = await createTrade("Switch Other");

  const listedFull = await makeTradesman("listed-full", trade, { isApproved: true, verificationStatus: "approved" });
  const listedNone = await makeTradesman("listed-none", trade, { isApproved: true, verificationStatus: "approved", licenseNumber: null, licenseDocument: null, licenseExpiry: null });
  const listedVerified = await makeTradesman("listed-verified", trade, { isApproved: true, verificationStatus: "approved", licenceVerified: true });
  const waitingPaid = await makeTradesman("waiting-paid", trade, {}, { subscription: "active" });
  const waitingUnpaid = await makeTradesman("waiting-unpaid", trade);
  const rejected = await makeTradesman("rejected", trade, { verificationStatus: "rejected", rejectionReason: "Earlier problem" }, { subscription: "active" });
  const testUser = await makeTradesman("test-user", trade, { isApproved: true, verificationStatus: "approved" }, { dummy: true });
  const elsewhere = await makeTradesman("elsewhere", other, { isApproved: true, verificationStatus: "approved" });
  const allIds = [listedFull, listedNone, listedVerified, waitingPaid, waitingUnpaid, rejected, testUser, elsewhere].map((p) => p.user.id);
  const snapshot = async () => Object.fromEntries(await Promise.all(allIds.map(async (id) => [id, await state(id)])));

  // Before: who would be affected either way (test users never counted).
  const impact = await call("GET", `/api/admin/trades/${trade.id}/licence-impact`);
  assert.equal(impact.status, 200);
  assert.deepEqual(impact.body.data, {
    trade: { id: trade.id, name: trade.name, licenceRequired: false },
    listedWithoutVerifiedLicence: 2,
    completeLicence: 1,
    missingLicence: 1,
    waitingForReview: 1,
  });
  assert.equal((await call("GET", "/api/admin/trades/999999999/licence-impact")).status, 404);

  // ON, but nobody is asked: the trade is flagged and not a single listing changes.
  const before = await snapshot();
  const on = await call("PATCH", `/api/admin/trades/${trade.id}`, { body: { licenceRequired: true } });
  assert.equal(on.status, 200);
  assert.equal(on.body.data.trade.licenceRequired, true);
  assert.equal(on.body.data.trade.licenceLabel, `${trade.name} licence`);
  assert.equal(on.body.data.applied, null);
  assert.deepEqual(await snapshot(), before, "nobody is delisted by default");

  // ON again with 'ask existing': listed tradespeople without a verified licence are asked.
  const applied = await call("PATCH", `/api/admin/trades/${trade.id}`, { body: { licenceRequired: true, applyToExisting: true } });
  assert.equal(applied.status, 200);
  assert.deepEqual(applied.body.data.applied, { pending: 1, rejected: 1 });

  const afterApply = await snapshot();
  assert.deepEqual(
    { status: afterApply[listedFull.user.id].status, approved: afterApply[listedFull.user.id].approved, userVerified: afterApply[listedFull.user.id].userVerified },
    { status: "pending", approved: false, userVerified: false },
    "complete licence details: straight back into the review queue",
  );
  assert.equal(afterApply[listedNone.user.id].status, "rejected");
  assert.match(afterApply[listedNone.user.id].reason, new RegExp(`licence is now required for ${trade.name}`));
  assert.equal(afterApply[listedNone.user.id].approved, false);
  // Untouched: a verified licence, people already waiting or rejected, test users, other trades.
  for (const person of [listedVerified, waitingPaid, waitingUnpaid, rejected, testUser, elsewhere]) {
    assert.deepEqual(afterApply[person.user.id], before[person.user.id], `${person.user.name} must not change`);
  }

  // They were told (in-app inbox), and only the two who changed.
  const inbox = await Notification.findAll({ where: { userId: allIds, type: "LICENCE_REQUIRED" } });
  assert.deepEqual(inbox.map((n) => n.userId).sort(), [listedFull.user.id, listedNone.user.id].sort());

  // Doing it again changes nothing and tells nobody twice.
  const again = await call("PATCH", `/api/admin/trades/${trade.id}`, { body: { licenceRequired: true, applyToExisting: true } });
  assert.deepEqual(again.body.data.applied, { pending: 0, rejected: 0 });
  assert.deepEqual(await snapshot(), afterApply);
  assert.equal(await Notification.count({ where: { userId: allIds, type: "LICENCE_REQUIRED" } }), 2);

  // OFF: paying members who were waiting are approved by the system; verified licences stay verified.
  const off = await call("PATCH", `/api/admin/trades/${trade.id}`, { body: { licenceRequired: false } });
  assert.equal(off.status, 200);
  assert.equal(off.body.data.autoApproved, 1, "only the paying member who was waiting");
  const afterOff = await snapshot();
  assert.deepEqual(
    afterOff[waitingPaid.user.id],
    { status: "approved", approved: true, licenceVerified: false, userVerified: true, approvedBy: null, reason: null },
  );
  assert.equal(afterOff[waitingUnpaid.user.id].status, "pending", "approved when they subscribe");
  assert.equal(afterOff[listedFull.user.id].status, "pending", "no subscription, so not approved");
  assert.equal(afterOff[rejected.user.id].status, "rejected", "rejected people must resubmit");
  assert.equal(afterOff[listedVerified.user.id].licenceVerified, true);
  assert.equal(afterOff[testUser.user.id].status, "approved");

  // Turning it off again is a no-op.
  const offAgain = await call("PATCH", `/api/admin/trades/${trade.id}`, { body: { licenceRequired: false } });
  assert.equal(offAgain.body.data.autoApproved, 0);
});

test("the label is kept when a requirement is switched off and on again", async () => {
  const trade = await createTrade("Label Keeper", { licenceRequired: true, licenceLabel: "My own wording" });
  await call("PATCH", `/api/admin/trades/${trade.id}`, { body: { licenceRequired: false } });
  const on = await call("PATCH", `/api/admin/trades/${trade.id}`, { body: { licenceRequired: true } });
  assert.equal(on.body.data.trade.licenceLabel, "My own wording");

  const cleared = await call("PATCH", `/api/admin/trades/${trade.id}`, { body: { licenceLabel: null } });
  assert.equal(cleared.body.data.trade.licenceLabel, `${trade.name} licence`, "a required trade always has a label");
});

test("two admins changing the same trade at once cannot corrupt it", async () => {
  const trade = await createTrade("Race");
  const results = await Promise.all([
    call("PATCH", `/api/admin/trades/${trade.id}`, { body: { licenceRequired: true, licenceLabel: "First" } }),
    call("PATCH", `/api/admin/trades/${trade.id}`, { body: { licenceRequired: true, licenceLabel: "Second" } }),
    call("PATCH", `/api/admin/trades/${trade.id}`, { body: { category: `${TAG} Moved` } }),
  ]);

  assert.deepEqual(results.map((r) => r.status), [200, 200, 200]);
  const final = await TradesType.findByPk(trade.id);
  assert.equal(final.licenceRequired, true);
  assert.ok(["First", "Second"].includes(final.licenceLabel));
  assert.equal(final.category, `${TAG} Moved`, "no update was lost");
});

/* ---------- automatic approval of unlicensed tradespeople ---------- */

test("autoApproveIfUnlicensed approves only waiting, paying, unlicensed tradespeople, silently and repeatably", async () => {
  const plain = await createTrade("Auto Plain");
  const licensed = await createTrade("Auto Licensed", { licenceRequired: true });

  const waiting = await makeTradesman("auto-ok", plain, {}, { subscription: "active" });
  const resubmitted = await makeTradesman("auto-resub", plain, { verificationStatus: "resubmitted" }, { subscription: "trialing" });
  const unpaid = await makeTradesman("auto-unpaid", plain);
  const licensedPaid = await makeTradesman("auto-licensed", licensed, {}, { subscription: "active" });
  const rejected = await makeTradesman("auto-rejected", plain, { verificationStatus: "rejected", rejectionReason: "x" }, { subscription: "active" });
  const approvedAlready = await makeTradesman("auto-approved", plain, { isApproved: true, verificationStatus: "approved" }, { subscription: "active" });
  const dummy = await makeTradesman("auto-dummy", plain, {}, { dummy: true, subscription: "active" });

  const emailsBefore = await EmailNotificationLog.count({ where: { recipientUserId: userIds } });

  assert.deepEqual(await autoApproveIfUnlicensed(waiting.user.id), { approved: true, reason: null });
  assert.deepEqual(await autoApproveIfUnlicensed(resubmitted.user.id), { approved: true, reason: null });
  assert.equal((await autoApproveIfUnlicensed(unpaid.user.id)).reason, "NOT_SUBSCRIBED");
  assert.equal((await autoApproveIfUnlicensed(licensedPaid.user.id)).reason, "LICENCE_REQUIRED");
  assert.equal((await autoApproveIfUnlicensed(rejected.user.id)).reason, "NOT_WAITING");
  assert.equal((await autoApproveIfUnlicensed(approvedAlready.user.id)).reason, "ALREADY_APPROVED");
  assert.equal((await autoApproveIfUnlicensed(dummy.user.id)).reason, "TEST_USER");
  assert.equal((await autoApproveIfUnlicensed(999999999)).reason, "NO_DETAILS");

  for (const person of [waiting, resubmitted]) {
    assert.deepEqual(await state(person.user.id), {
      status: "approved", approved: true, licenceVerified: false, userVerified: true, approvedBy: null, reason: null,
    });
  }
  assert.equal((await state(unpaid.user.id)).status, "pending");
  assert.equal((await state(licensedPaid.user.id)).status, "pending");
  assert.equal((await state(rejected.user.id)).status, "rejected");
  assert.equal((await state(dummy.user.id)).status, "pending");

  // Calling it again (a webhook retry, the daily re-sync) is harmless.
  assert.equal((await autoApproveIfUnlicensed(waiting.user.id)).reason, "ALREADY_APPROVED");

  // Silent: no "profile approved" push or email for someone nobody reviewed.
  assert.equal(await Notification.count({ where: { userId: [waiting.user.id, resubmitted.user.id] } }), 0);
  assert.equal(await EmailNotificationLog.count({ where: { recipientUserId: userIds } }), emailsBefore);
});

test("the public trade list carries the licence flag and label for the app", async () => {
  const trade = await createTrade("Public", { licenceRequired: true, licenceLabel: "Public licence" });
  const response = await call("GET", "/api/trades", { as: null });
  assert.equal(response.status, 200);
  const found = response.body.data.find((t) => t.id === trade.id);
  assert.equal(found.licenceRequired, true);
  assert.equal(found.licenceLabel, "Public licence");
});
