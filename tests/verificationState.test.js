const assert = require("node:assert/strict");
const test = require("node:test");
const bcrypt = require("bcryptjs");

process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";

const sequelize = require("../config/db");
const User = require("../models/User");
const TradesmanDetails = require("../models/TradesmanDetails");
const TradesType = require("../models/tradesTypeModel");
const SubscriptionPlan = require("../models/SubscriptionPlan");
const UserSubscription = require("../models/UserSubscription");
const {
  STATES,
  buildStatePatch,
  applyVerificationState,
  isLicenceRequired,
  brisbaneDateKey,
  licenceExpiryStatus,
} = require("../services/verificationStateService");
const migration = require("../migrations/20261022-0018-trade-licence-requirements");

const suffix = `${Date.now()}-${process.pid}`;
const TAG = `vs${Date.now().toString(36)}`;
const NOW = new Date("2026-10-21T10:00:00Z");

let tradeLicensed;
let tradePlain;
let plan;
const userIds = [];
const tradeIds = [];

const makeTradesman = async (label, trade, overrides = {}, { dummy = false, subscription = null } = {}) => {
  const user = await User.create({
    name: `${TAG} ${label}`,
    email: `${TAG}-${label}-${suffix}@test.com`,
    mobile: "0411111111",
    password: await bcrypt.hash("Password123!", 10),
    role: "tradesman",
    provider: "manual",
    isDummy: dummy,
  });
  userIds.push(user.id);

  const details = await TradesmanDetails.create({
    userId: user.id,
    tradeType: trade.name,
    tradeTypeId: trade.id,
    businessName: `${TAG} ${label} Co`,
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
      currentPeriodEnd: subscription === "canceled" ? new Date(Date.now() - 10 * 864e5) : new Date(Date.now() + 30 * 864e5),
    });
  }
  return { user, details };
};

const snapshot = async (ids) => {
  const rows = await TradesmanDetails.findAll({ where: { userId: ids }, order: [["userId", "ASC"]] });
  const users = await User.findAll({ where: { id: ids }, order: [["id", "ASC"]] });
  const verified = Object.fromEntries(users.map((u) => [u.id, u.isVerified]));
  return rows.map((d) => ({
    userId: d.userId,
    status: d.verificationStatus,
    approved: d.isApproved,
    licenceVerified: d.licenceVerified,
    userVerified: verified[d.userId],
    approvedBy: d.approvedBy,
    reason: d.rejectionReason,
  }));
};

test.before(async () => {
  await sequelize.authenticate();
  tradeLicensed = await TradesType.create({ name: `${TAG} Licensed`, category: "Test", licenceRequired: true, licenceLabel: `${TAG} licence` });
  tradePlain = await TradesType.create({ name: `${TAG} Plain`, category: "Test", licenceRequired: false });
  tradeIds.push(tradeLicensed.id, tradePlain.id);
  plan = await SubscriptionPlan.create({ name: `${TAG} Plan`, priceMonthly: 9, stripePriceId: `price_${TAG}_${suffix}` });
});

test.after(async () => {
  await UserSubscription.destroy({ where: { userId: userIds } });
  await TradesmanDetails.destroy({ where: { userId: userIds } });
  await User.destroy({ where: { id: userIds } });
  await TradesType.destroy({ where: { id: tradeIds } });
  await SubscriptionPlan.destroy({ where: { id: plan.id } });
  await sequelize.close();
});

/* ---------- the state patch ---------- */

test("every state sets all four values together", () => {
  assert.deepEqual(STATES, ["pending", "resubmitted", "approved", "rejected"]);

  const approved = buildStatePatch("approved", { adminId: 7, licenceVerified: true, now: NOW });
  assert.deepEqual(approved, {
    details: {
      isApproved: true, verificationStatus: "approved", licenceVerified: true,
      approvedBy: 7, approvedAt: NOW, rejectionReason: null,
    },
    user: { isVerified: true },
  });

  const auto = buildStatePatch("approved", { now: NOW }); // automatic approval of an unlicensed trade
  assert.equal(auto.details.approvedBy, null);
  assert.equal(auto.details.licenceVerified, false);
  assert.equal(auto.user.isVerified, true);

  const rejected = buildStatePatch("rejected", { adminId: 7, reason: "Blurry", now: NOW });
  assert.deepEqual(rejected.details, {
    isApproved: false, verificationStatus: "rejected", licenceVerified: false,
    approvedBy: 7, approvedAt: NOW, rejectionReason: "Blurry",
  });
  assert.equal(rejected.user.isVerified, false);

  const resubmitted = buildStatePatch("resubmitted", { now: NOW });
  assert.equal(resubmitted.details.isApproved, false);
  assert.equal(resubmitted.details.resubmittedAt, NOW);
  assert.ok(!("rejectionReason" in resubmitted.details), "the earlier reason is kept for the admin");

  const pending = buildStatePatch("pending");
  assert.deepEqual(pending.details, {
    isApproved: false, verificationStatus: "pending", licenceVerified: false, rejectionReason: null,
  });
  assert.equal(pending.user.isVerified, false);
});

test("only an approval can carry a verified licence", () => {
  for (const state of ["pending", "resubmitted", "rejected"]) {
    const patch = buildStatePatch(state, { licenceVerified: true, reason: "x" });
    assert.equal(patch.details.licenceVerified, false, state);
    assert.equal(patch.details.isApproved, false, state);
    assert.equal(patch.user.isVerified, false, state);
  }
});

test("bad input is refused", () => {
  assert.throws(() => buildStatePatch("suspended"), /Unknown verification state/);
  assert.throws(() => buildStatePatch("rejected"), /rejection reason is required/i);
});

/* ---------- applying it to real rows ---------- */

test("applyVerificationState keeps the details row and the user row in step", async () => {
  const { user, details } = await makeTradesman("apply", tradeLicensed);

  await applyVerificationState(details, user, "approved", { adminId: null, licenceVerified: true });
  assert.deepEqual((await snapshot([user.id]))[0], {
    userId: user.id, status: "approved", approved: true, licenceVerified: true, userVerified: true, approvedBy: null, reason: null,
  });

  await applyVerificationState(details, user, "rejected", { adminId: null, reason: "Licence expired" });
  const rejected = (await snapshot([user.id]))[0];
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.approved, false);
  assert.equal(rejected.licenceVerified, false);
  assert.equal(rejected.userVerified, false);
  assert.equal(rejected.reason, "Licence expired");

  await applyVerificationState(details, user, "resubmitted");
  const resubmitted = (await snapshot([user.id]))[0];
  assert.equal(resubmitted.status, "resubmitted");
  assert.equal(resubmitted.reason, "Licence expired", "kept for the admin");

  await applyVerificationState(details, user, "pending");
  assert.equal((await snapshot([user.id]))[0].reason, null);
});

test("inside a transaction a failure leaves both rows untouched", async () => {
  const { user, details } = await makeTradesman("rollback", tradePlain);
  const before = await snapshot([user.id]);

  await assert.rejects(
    sequelize.transaction(async (transaction) => {
      await applyVerificationState(details, user, "approved", { transaction });
      throw new Error("something later failed");
    }),
    /something later failed/,
  );

  assert.deepEqual(await snapshot([user.id]), before);
});

test("isLicenceRequired asks the trade, and unknown trades are not regulated", async () => {
  assert.equal(await isLicenceRequired(tradeLicensed.id), true);
  assert.equal(await isLicenceRequired(tradePlain.id), false);
  assert.equal(await isLicenceRequired(999999999), false);
  assert.equal(await isLicenceRequired(null), false);
  assert.equal(await isLicenceRequired(undefined), false);
});

/* ---------- licence expiry (Queensland dates) ---------- */

test("expiry is judged by the calendar date in Queensland", () => {
  // 13:30 UTC on 21 Oct is 23:30 on 21 Oct in Brisbane (UTC+10): the licence expiring "2026-10-21" is on its last day.
  const lastDay = new Date("2026-10-21T13:30:00Z");
  assert.equal(brisbaneDateKey(lastDay), "2026-10-21");
  assert.deepEqual(licenceExpiryStatus("2026-10-21T00:00:00Z", lastDay), { known: true, expired: false, daysLeft: 0 });

  // One hour later it is already the 22nd in Brisbane: expired.
  const nextDay = new Date("2026-10-21T14:30:00Z");
  assert.equal(brisbaneDateKey(nextDay), "2026-10-22");
  assert.deepEqual(licenceExpiryStatus("2026-10-21T00:00:00Z", nextDay), { known: true, expired: true, daysLeft: -1 });
});

test("expiry reports days left, in the past or the future, and copes with missing dates", () => {
  assert.equal(licenceExpiryStatus("2026-11-20T00:00:00Z", NOW).daysLeft, 30);
  assert.equal(licenceExpiryStatus(new Date("2026-10-01T00:00:00Z"), NOW).daysLeft, -20);
  assert.equal(licenceExpiryStatus("2026-10-01", NOW).expired, true);
  assert.equal(licenceExpiryStatus("2030-01-01", NOW).expired, false);

  for (const missing of [null, undefined, "", "not a date"]) {
    assert.deepEqual(licenceExpiryStatus(missing, NOW), { known: false, expired: false, daysLeft: null });
  }
});

/* ---------- the migration ---------- */

test("the migration's starter trades exist once each, with labels, and unlicensed trades are untouched", async () => {
  const trades = await TradesType.findAll();
  const named = (name) => trades.filter((t) => t.name.toLowerCase().replace(/[^a-z0-9]/g, "") === name);

  for (const name of ["electrician", "plumber", "gasfitter", "builder", "airconditioningtechnician", "roofer", "waterproofer", "painter", "tiler", "carpenter"]) {
    const found = named(name);
    assert.equal(found.length, 1, `${name} must exist exactly once`);
    assert.equal(found[0].licenceRequired, true, `${name} is licence-required`);
    assert.ok(found[0].licenceLabel && found[0].licenceLabel.length <= 120, `${name} has a label`);
  }
  assert.equal(tradePlain.licenceRequired, false);
});

test("backfill: licences are marked verified, unlicensed subscribers go live, nothing else changes", async () => {
  const cases = {
    approvedLicensedFull: await makeTradesman("a-full", tradeLicensed, { isApproved: true, verificationStatus: "approved" }),
    approvedLicensedNoDoc: await makeTradesman("a-nodoc", tradeLicensed, { isApproved: true, verificationStatus: "approved", licenseDocument: null }),
    approvedLicensedNoNumber: await makeTradesman("a-nonum", tradeLicensed, { isApproved: true, verificationStatus: "approved", licenseNumber: "" }),
    approvedPlain: await makeTradesman("a-plain", tradePlain, { isApproved: true, verificationStatus: "approved" }),
    pendingPlainPaying: await makeTradesman("p-plain-paid", tradePlain, {}, { subscription: "active" }),
    resubmittedPlainTrial: await makeTradesman("r-plain-trial", tradePlain, { verificationStatus: "resubmitted" }, { subscription: "trialing" }),
    pendingPlainUnpaid: await makeTradesman("p-plain-unpaid", tradePlain),
    pendingPlainLapsed: await makeTradesman("p-plain-lapsed", tradePlain, {}, { subscription: "canceled" }),
    pendingLicensedPaying: await makeTradesman("p-lic-paid", tradeLicensed, {}, { subscription: "active" }),
    rejectedPlainPaying: await makeTradesman("rej-plain", tradePlain, { verificationStatus: "rejected", rejectionReason: "Fix it" }, { subscription: "active" }),
    pendingPlainDummy: await makeTradesman("p-plain-dummy", tradePlain, {}, { dummy: true, subscription: "active" }),
  };
  const ids = Object.values(cases).map((c) => c.user.id);
  const idOf = (key) => cases[key].user.id;
  const tradeCountBefore = await TradesType.count();

  await migration.up({ context: sequelize.getQueryInterface() });
  const after = Object.fromEntries((await snapshot(ids)).map((row) => [row.userId, row]));
  const at = (key) => after[idOf(key)];

  // Licence-required trade, approved, complete licence details: verified.
  assert.equal(at("approvedLicensedFull").licenceVerified, true);
  // ...but not when the licence details are incomplete.
  assert.equal(at("approvedLicensedNoDoc").licenceVerified, false);
  assert.equal(at("approvedLicensedNoNumber").licenceVerified, false);
  assert.equal(at("approvedLicensedNoDoc").approved, true, "still listed: nobody is delisted");
  // Unlicensed trade: approved is not "licence verified".
  assert.equal(at("approvedPlain").licenceVerified, false);

  // Waiting, unlicensed and a paying member: approved automatically, counted as verified for the dashboard.
  for (const key of ["pendingPlainPaying", "resubmittedPlainTrial"]) {
    assert.equal(at(key).status, "approved", key);
    assert.equal(at(key).approved, true, key);
    assert.equal(at(key).userVerified, true, key);
    assert.equal(at(key).licenceVerified, false, key);
    assert.equal(at(key).approvedBy, null, `${key} was approved by the system, not an admin`);
  }

  // Everyone else keeps waiting or stays rejected.
  assert.equal(at("pendingPlainUnpaid").status, "pending", "approved later, when they subscribe");
  assert.equal(at("pendingPlainLapsed").status, "pending", "a lapsed subscription does not count");
  assert.equal(at("pendingLicensedPaying").status, "pending", "licensed trades need a person to check the licence");
  assert.equal(at("rejectedPlainPaying").status, "rejected");
  assert.equal(at("rejectedPlainPaying").reason, "Fix it");
  assert.equal(at("pendingPlainDummy").status, "pending", "test users are left alone");

  // Running it again changes nothing at all, and adds no duplicate trades.
  const firstRun = await snapshot(ids);
  await migration.up({ context: sequelize.getQueryInterface() });
  assert.deepEqual(await snapshot(ids), firstRun);
  assert.equal(await TradesType.count(), tradeCountBefore);
});

test("re-running never overwrites a label an admin has already customised", async () => {
  const plumber = (await TradesType.findAll()).find((t) => t.name === "Plumber");
  const original = { licenceRequired: plumber.licenceRequired, licenceLabel: plumber.licenceLabel };

  try {
    await plumber.update({ licenceLabel: "Custom plumbing licence wording" });
    await migration.up({ context: sequelize.getQueryInterface() });
    assert.equal((await TradesType.findByPk(plumber.id)).licenceLabel, "Custom plumbing licence wording");
  } finally {
    await plumber.update(original);
  }
});
