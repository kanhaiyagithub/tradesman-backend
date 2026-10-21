const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const sharp = require("sharp");

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
const { resetRateLimitBuckets } = require("../middlewares/rateLimitMiddleware");
const storageService = require("../services/storage/storageService");
const { _private: stripePrivate } = require("../controllers/stripeWebhookController");

const suffix = `${Date.now()}-${process.pid}`;
const TAG = `tf${Date.now().toString(36)}`;

let server;
let baseUrl;
let adminToken;
let png;
let plan;
let licensed; // licence-required trade
let plain; // no licence needed
const userIds = [];
const tradeIds = [];
const adminIds = [];

const parse = async (response) => {
  const text = await response.text();
  try {
    return { status: response.status, body: text ? JSON.parse(text) : null };
  } catch {
    return { status: response.status, body: text };
  }
};

const callJson = async (method, path, { body, token = adminToken } = {}) =>
  parse(
    await fetch(`${baseUrl}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    }),
  );

/** Multipart request. `files` maps field name -> true (attach one PNG). Empty-string fields are sent as-is. */
const callForm = async (method, path, { fields = {}, files = {}, token } = {}) => {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  for (const [key, count] of Object.entries(files)) {
    for (let i = 0; i < (count === true ? 1 : count); i += 1) {
      form.append(key, new Blob([png], { type: "image/png" }), `${key}-${i}.png`);
    }
  }
  return parse(
    await fetch(`${baseUrl}${path}`, {
      method,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: form,
    }),
  );
};

let counter = 0;
const registerFields = (trade, extra = {}) => {
  counter += 1;
  return {
    name: `${TAG} Tradie ${counter}`,
    email: `${TAG}-reg-${counter}-${suffix}@test.com`,
    mobile: "0411111111",
    password: "Password123!",
    role: "tradesman",
    tradeTypeId: String(trade.id),
    businessName: `${TAG} Co ${counter}`,
    shortBio: "Reliable and tidy",
    ...extra,
  };
};

const register = async (trade, { fields = {}, files = { profileImage: true } } = {}) => {
  resetRateLimitBuckets(); // signup is rate limited; these tests register many people
  const payload = registerFields(trade, fields);
  const response = await callForm("POST", "/api/users/register", { fields: payload, files });
  const user = await User.findOne({ where: { email: payload.email } });
  if (user) userIds.push(user.id);
  return { response, user, payload };
};

const detailsOf = (userId) => TradesmanDetails.findOne({ where: { userId } });

const tokenFor = (user) => jwt.sign({ id: user.id, email: user.email, role: "tradesman" }, process.env.JWT_SECRET);

const subscribe = async (userId) => {
  const stripeId = `sub_${TAG}_${userId}`;
  await UserSubscription.create({
    userId,
    planId: plan.id,
    status: "incomplete",
    stripeSubscriptionId: stripeId,
    stripeCustomerId: `cus_${TAG}_${userId}`,
  });
  // The same function every Stripe webhook and the daily re-sync call.
  await stripePrivate.syncSubscriptionFromStripe({
    id: stripeId,
    customer: `cus_${TAG}_${userId}`,
    status: "active",
    current_period_start: Math.floor(Date.now() / 1000),
    current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
    items: { data: [{ price: { id: null }, current_period_start: Math.floor(Date.now() / 1000), current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400 }] },
  });
};

test.before(async () => {
  png = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#cc3300" } }).png().toBuffer();

  plan = await SubscriptionPlan.findOne();
  assert.ok(plan, "a subscription plan seed is required");

  const admin = await Admin.create({
    name: `${TAG} Admin`,
    email: `${TAG}-admin-${suffix}@test.com`,
    password: await bcrypt.hash("Password123!", 10),
  });
  adminIds.push(admin.id);
  adminToken = jwt.sign({ id: admin.id, role: "admin" }, process.env.JWT_SECRET);

  licensed = await TradesType.create({ name: `${TAG} Licensed`, category: `${TAG} Cat`, isActive: true, licenceRequired: true, licenceLabel: `${TAG} licence` });
  plain = await TradesType.create({ name: `${TAG} Plain`, category: `${TAG} Cat`, isActive: true, licenceRequired: false });
  tradeIds.push(licensed.id, plain.id);

  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  const rows = await TradesmanDetails.findAll({ where: { userId: userIds } });
  const users = await User.findAll({ where: { id: userIds } });
  const keys = [
    ...rows.flatMap((row) => [
      ...(row.licenseDocument ? [{ key: row.licenseDocument, category: "license" }] : []),
      ...(Array.isArray(row.portfolioPhotos) ? row.portfolioPhotos : []).map((key) => ({ key, category: "portfolio" })),
    ]),
    ...users.filter((u) => u.profileImage).map((u) => ({ key: u.profileImage, category: "profile" })),
  ];
  await Promise.all(keys.map(({ key, category }) => storageService.deleteObject(key, { category }).catch(() => {})));

  await Notification.destroy({ where: { userId: userIds } });
  await EmailNotificationLog.destroy({ where: { tradesmanId: userIds } });
  await UserSubscription.destroy({ where: { userId: userIds } });
  await TradesmanDetails.destroy({ where: { userId: userIds } });
  await User.destroy({ where: { id: userIds } });
  await TradesType.destroy({ where: { id: tradeIds } });
  await Admin.destroy({ where: { id: adminIds } });
  await new Promise((resolve) => server.close(resolve));
  await sequelize.close();
});

/* ---------------------------------------------------------------- register */

test("licence-required trade: licence is compulsory and the answer says exactly what is missing", async () => {
  const none = await register(licensed);
  assert.equal(none.response.status, 400);
  assert.equal(none.response.body.data.code, "LICENCE_REQUIRED");
  assert.equal(none.response.body.data.licenceLabel, `${TAG} licence`);
  assert.deepEqual([...none.response.body.data.missingFields].sort(), ["licenseDocument", "licenseExpiry", "licenseNumber"]);
  assert.equal(none.user, null, "nothing was created");

  const partial = await register(licensed, { fields: { licenseNumber: "L-1" } });
  assert.equal(partial.response.status, 400);
  assert.deepEqual([...partial.response.body.data.missingFields].sort(), ["licenseDocument", "licenseExpiry"]);

  const full = await register(licensed, {
    fields: { licenseNumber: "L-1", licenseExpiry: "2031-01-01" },
    files: { profileImage: true, licenseDocument: true },
  });
  assert.equal(full.response.status, 201, JSON.stringify(full.response.body));
  const details = await detailsOf(full.user.id);
  assert.equal(details.verificationStatus, "pending");
  assert.equal(details.isApproved, false);
  assert.equal(details.licenceVerified, false);
  assert.equal(details.licenseNumber, "L-1");
});

test("unlicensed trade: no licence and no portfolio needed, profile photo still compulsory", async () => {
  const noPhoto = await register(plain, { files: {} });
  assert.equal(noPhoto.response.status, 400);

  const bare = await register(plain);
  assert.equal(bare.response.status, 201, JSON.stringify(bare.response.body));
  const details = await detailsOf(bare.user.id);
  assert.equal(details.licenseNumber, null);
  assert.equal(details.licenseDocument, null);
  assert.equal(details.verificationStatus, "pending", "waits for the subscription, not for an admin");
  assert.equal(details.isApproved, false);
});

test("old app builds that send empty or 'null' licence fields still register on an unlicensed trade", async () => {
  const emptyStrings = await register(plain, { fields: { licenseNumber: "", licenseExpiry: "", portfolioDescription: "" } });
  assert.equal(emptyStrings.response.status, 201, JSON.stringify(emptyStrings.response.body));
  const a = await detailsOf(emptyStrings.user.id);
  assert.equal(a.licenseNumber, null);
  assert.equal(a.licenseExpiry, null);

  const literal = await register(plain, { fields: { licenseNumber: "null", licenseExpiry: "undefined", portfolioDescription: "  " } });
  assert.equal(literal.response.status, 201, JSON.stringify(literal.response.body));
  const b = await detailsOf(literal.user.id);
  assert.equal(b.licenseNumber, null);
  assert.equal(b.licenseExpiry, null);

  // The same junk on a licence-required trade is "not provided", so it is refused.
  const refused = await register(licensed, { fields: { licenseNumber: "null", licenseExpiry: "" } });
  assert.equal(refused.response.status, 400);
});

test("an unlicensed trade keeps a licence only when all three parts are given", async () => {
  const partial = await register(plain, { fields: { licenseNumber: "P-1" } });
  assert.equal(partial.response.status, 201);
  assert.equal((await detailsOf(partial.user.id)).licenseNumber, null, "half a licence is ignored");

  const full = await register(plain, {
    fields: { licenseNumber: "P-2", licenseExpiry: "2031-01-01" },
    files: { profileImage: true, licenseDocument: true },
  });
  assert.equal(full.response.status, 201);
  const details = await detailsOf(full.user.id);
  assert.equal(details.licenseNumber, "P-2");
  assert.ok(details.licenseDocument);
  assert.equal(details.licenceVerified, false, "only an admin can verify a licence");
});

/* -------------------------------------------------------------- subscribe */

test("subscribing approves an unlicensed tradesperson silently, and never a licensed one", async () => {
  const free = await register(plain);
  const regulated = await register(licensed, {
    fields: { licenseNumber: "L-9", licenseExpiry: "2031-01-01" },
    files: { profileImage: true, licenseDocument: true },
  });

  await subscribe(free.user.id);
  await subscribe(regulated.user.id);

  const a = await detailsOf(free.user.id);
  assert.equal(a.isApproved, true);
  assert.equal(a.verificationStatus, "approved");
  assert.equal(a.licenceVerified, false);
  assert.equal(a.approvedBy, null);
  assert.equal((await User.findByPk(free.user.id)).isVerified, true);
  assert.equal(await Notification.count({ where: { userId: free.user.id, type: "PROFILE_APPROVED" } }), 0, "silent");

  const b = await detailsOf(regulated.user.id);
  assert.equal(b.isApproved, false);
  assert.equal(b.verificationStatus, "pending");

  // Running the hook again (webhook retry / daily re-sync) changes nothing.
  await subscribe(free.user.id).catch(() => {});
  assert.equal((await detailsOf(free.user.id)).approvedBy, null);
});

test("the admin queue and its count only contain licence-required trades", async () => {
  const free = await register(plain);
  const regulated = await register(licensed, {
    fields: { licenseNumber: "L-10", licenseExpiry: "2031-01-01" },
    files: { profileImage: true, licenseDocument: true },
  });
  await UserSubscription.create({ userId: free.user.id, planId: plan.id, status: "active", currentPeriodEnd: new Date(Date.now() + 864e5) });
  await UserSubscription.create({ userId: regulated.user.id, planId: plan.id, status: "active", currentPeriodEnd: new Date(Date.now() + 864e5) });

  const queue = await callJson("GET", `/api/admin/tradesmen/pending?search=${TAG}&limit=100`);
  assert.equal(queue.status, 200);
  const ids = queue.body.data.data.map((row) => row.userId);
  assert.ok(ids.includes(regulated.user.id));
  assert.ok(!ids.includes(free.user.id), "nothing to review for an unlicensed trade");

  // The dashboard is told what the trade expects.
  const row = queue.body.data.data.find((item) => item.userId === regulated.user.id);
  assert.equal(row.licenceRequired, true);
  assert.equal(row.licenceLabel, `${TAG} licence`);
  const detail = await callJson("GET", `/api/admin/tradesmen/${regulated.user.id}`);
  assert.equal(detail.body.data.licenceRequired, true);
  assert.equal(detail.body.data.licenceVerified, false);
});

test("admin approval sets 'licence verified' only for licence-required trades", async () => {
  const regulated = await register(licensed, {
    fields: { licenseNumber: "L-11", licenseExpiry: "2031-01-01" },
    files: { profileImage: true, licenseDocument: true },
  });
  const approve = await callJson("POST", `/api/admin/tradesmen/${regulated.user.id}/approve`);
  assert.equal(approve.status, 200, JSON.stringify(approve.body));
  const details = await detailsOf(regulated.user.id);
  assert.equal(details.licenceVerified, true);
  assert.equal(details.isApproved, true);
  assert.equal((await User.findByPk(regulated.user.id)).isVerified, true);
});

/* ------------------------------------------------------------ trade change */

const approvedOn = async (trade, { licence = false } = {}) => {
  const created = await register(
    trade,
    licence
      ? { fields: { licenseNumber: "L-20", licenseExpiry: "2031-01-01" }, files: { profileImage: true, licenseDocument: true } }
      : {},
  );
  assert.equal(created.response.status, 201, JSON.stringify(created.response.body));
  await subscribe(created.user.id);
  if (licence) await callJson("POST", `/api/admin/tradesmen/${created.user.id}/approve`);
  return created.user;
};

test("switching from an unlicensed to a licence-required trade needs a licence and goes back to pending", async () => {
  const user = await approvedOn(plain);
  assert.equal((await detailsOf(user.id)).isApproved, true);
  const token = tokenFor(user);

  const refused = await callForm("PUT", "/api/users/profile/update", { fields: { tradeTypeId: String(licensed.id) }, token });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.data.code, "LICENCE_REQUIRED");
  assert.equal((await detailsOf(user.id)).tradeTypeId, plain.id, "nothing was saved");

  const ok = await callForm("PUT", "/api/users/profile/update", {
    fields: { tradeTypeId: String(licensed.id), licenseNumber: "L-30", licenseExpiry: "2031-06-01" },
    files: { licenseDocument: true },
    token,
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const details = await detailsOf(user.id);
  assert.equal(details.tradeTypeId, licensed.id);
  assert.equal(details.isApproved, false);
  assert.equal(details.verificationStatus, "pending");
  assert.equal(details.licenceVerified, false);
  assert.equal((await User.findByPk(user.id)).isVerified, false);
  assert.equal(ok.body.data.tradesman.licenceRequired, true);
});

test("a licence-required profile cannot swap its licence outside the resubmit flow", async () => {
  const user = await approvedOn(licensed, { licence: true });
  const token = tokenFor(user);
  assert.equal((await detailsOf(user.id)).licenceVerified, true);

  const number = await callForm("PUT", "/api/users/profile/update", { fields: { licenseNumber: "SNEAKY-1" }, token });
  assert.equal(number.status, 400);
  assert.equal(number.body.data.code, "LICENCE_LOCKED");

  const doc = await callForm("PUT", "/api/users/profile/update", { files: { licenseDocument: true }, token });
  assert.equal(doc.status, 400);

  const details = await detailsOf(user.id);
  assert.equal(details.licenseNumber, "L-20");
  assert.equal(details.licenceVerified, true);

  // Re-sending the same licence number (an app that always posts the whole form) is fine.
  const same = await callForm("PUT", "/api/users/profile/update", { fields: { licenseNumber: "L-20", shortBio: "New bio" }, token });
  assert.equal(same.status, 200, JSON.stringify(same.body));
  assert.equal((await detailsOf(user.id)).shortBio, "New bio");
});

test("switching to an unlicensed trade drops 'licence verified' but keeps an approved profile listed", async () => {
  const user = await approvedOn(licensed, { licence: true });
  const token = tokenFor(user);

  const moved = await callForm("PUT", "/api/users/profile/update", { fields: { tradeTypeId: String(plain.id) }, token });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  const details = await detailsOf(user.id);
  assert.equal(details.tradeTypeId, plain.id);
  assert.equal(details.licenceVerified, false);
  assert.equal(details.isApproved, true);

  // ...and back again: a new licence is needed, the old verification does not come back.
  const back = await callForm("PUT", "/api/users/profile/update", { fields: { tradeTypeId: String(licensed.id) }, token });
  assert.equal(back.status, 400);
  const backOk = await callForm("PUT", "/api/users/profile/update", {
    fields: { tradeTypeId: String(licensed.id), licenseNumber: "L-31", licenseExpiry: "2032-01-01" },
    files: { licenseDocument: true },
    token,
  });
  assert.equal(backOk.status, 200, JSON.stringify(backOk.body));
  const again = await detailsOf(user.id);
  assert.equal(again.verificationStatus, "pending");
  assert.equal(again.licenceVerified, false);
  assert.equal(again.isApproved, false);
});

test("a bad profile update saves nothing", async () => {
  const user = await approvedOn(plain);
  const token = tokenFor(user);
  const before = await detailsOf(user.id);

  const bad = await callForm("PUT", "/api/users/profile/update", {
    fields: { shortBio: "Changed", tradeTypeId: "999999999" },
    token,
  });
  assert.equal(bad.status, 400);
  assert.equal((await detailsOf(user.id)).shortBio, before.shortBio);

  const badDate = await callForm("PUT", "/api/users/profile/update", {
    fields: { shortBio: "Changed", licenseExpiry: "not-a-date" },
    token,
  });
  assert.equal(badDate.status, 400);
  assert.equal((await detailsOf(user.id)).shortBio, before.shortBio);
});

/* ---------------------------------------------------------------- resubmit */

test("resubmit: a licence-required profile goes back to the queue, an unlicensed one is listed at once", async () => {
  const regulated = await register(licensed, {
    fields: { licenseNumber: "L-40", licenseExpiry: "2031-01-01" },
    files: { profileImage: true, licenseDocument: true },
  });
  await subscribe(regulated.user.id);
  const reject = await callJson("POST", `/api/admin/tradesmen/${regulated.user.id}/reject`, { body: { reason: "Photo is blurry" } });
  assert.equal(reject.status, 200, JSON.stringify(reject.body));

  const resubmit = await callForm("POST", "/api/users/profile/resubmit", {
    fields: { licenseNumber: "L-41", licenseExpiry: "2032-01-01" },
    files: { licenseDocument: true },
    token: tokenFor(regulated.user),
  });
  assert.equal(resubmit.status, 200, JSON.stringify(resubmit.body));
  const details = await detailsOf(regulated.user.id);
  assert.equal(details.verificationStatus, "resubmitted");
  assert.equal(details.isApproved, false);
  assert.equal(details.licenseNumber, "L-41");

  // An unlicensed tradesperson rejected earlier (e.g. before this trade stopped needing a licence).
  const free = await register(plain);
  await subscribe(free.user.id);
  await TradesmanDetails.update({ isApproved: false, verificationStatus: "rejected", rejectionReason: "Old reason" }, { where: { userId: free.user.id } });
  const resubmitFree = await callForm("POST", "/api/users/profile/resubmit", { fields: { shortBio: "Better bio" }, token: tokenFor(free.user) });
  assert.equal(resubmitFree.status, 200, JSON.stringify(resubmitFree.body));
  const listed = await detailsOf(free.user.id);
  assert.equal(listed.isApproved, true);
  assert.equal(listed.verificationStatus, "approved");
});

test("resubmit on a licence-required trade still demands the licence", async () => {
  const regulated = await register(licensed, {
    fields: { licenseNumber: "L-50", licenseExpiry: "2031-01-01" },
    files: { profileImage: true, licenseDocument: true },
  });
  await subscribe(regulated.user.id);
  await callJson("POST", `/api/admin/tradesmen/${regulated.user.id}/reject`, { body: { reason: "Wrong document" } });
  await TradesmanDetails.update({ licenseNumber: null }, { where: { userId: regulated.user.id } });

  const response = await callForm("POST", "/api/users/profile/resubmit", { fields: {}, token: tokenFor(regulated.user) });
  assert.equal(response.status, 400);
  assert.ok(response.body.data.missingFields.includes("licenseNumber"));
});
