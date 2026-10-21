const assert = require("node:assert/strict");
const test = require("node:test");
const bcrypt = require("bcryptjs");
const nodemailer = require("nodemailer");

// Capture outgoing mail instead of sending it. Must happen before emailService loads.
const sentMail = [];
nodemailer.createTransport = () => ({
  sendMail: async (message) => {
    sentMail.push(message);
    return { messageId: `test-${sentMail.length}` };
  },
});
process.env.SMTP_HOST = "smtp.test.local";
process.env.SMTP_PORT = "587";
process.env.SMTP_USER = "test";
process.env.SMTP_PASS = "test";
process.env.SMTP_FROM = "Touring Trades <no-reply@test.local>";

const sequelize = require("../config/db");
const Admin = require("../models/AdminModel/adminModel");
const User = require("../models/User");
const TradesmanDetails = require("../models/TradesmanDetails");
const TradesType = require("../models/tradesTypeModel");
const SubscriptionPlan = require("../models/SubscriptionPlan");
const UserSubscription = require("../models/UserSubscription");
const EmailNotificationLog = require("../models/EmailNotificationLog");
const { handleTradesmanSubscribed } = require("../services/subscriptionApprovalService");

const suffix = `${Date.now()}-${process.pid}`;
const TAG = `sn${Date.now().toString(36)}`;
const userIds = [];
const tradeIds = [];
const adminIds = [];
let plan;
let licensed;
let plain;

const makeTradesman = async (label, trade) => {
  const user = await User.create({
    name: `${TAG} ${label}`,
    email: `${TAG}-${label}-${suffix}@test.com`,
    mobile: "0411111111",
    password: await bcrypt.hash("Password123!", 10),
    role: "tradesman",
    provider: "manual",
    profileImage: "profile/x.png",
  });
  userIds.push(user.id);
  await TradesmanDetails.create({
    userId: user.id,
    tradeType: trade.name,
    tradeTypeId: trade.id,
    businessName: `${TAG} ${label} Co`,
    shortBio: "bio",
    licenseNumber: trade.licenceRequired ? "L-1" : null,
    licenseExpiry: trade.licenceRequired ? new Date("2031-01-01") : null,
    licenseDocument: trade.licenceRequired ? "license/x.png" : null,
  });
  await UserSubscription.create({
    userId: user.id,
    planId: plan.id,
    status: "trialing",
    currentPeriodEnd: new Date(Date.now() + 30 * 864e5),
  });
  return user;
};

const mailAbout = (user) => sentMail.filter((m) => String(m.html || m.text || "").includes(user.email));

test.before(async () => {
  plan = await SubscriptionPlan.findOne();
  assert.ok(plan, "a subscription plan seed is required");
  const admin = await Admin.create({
    name: `${TAG} Admin`,
    email: `${TAG}-admin-${suffix}@test.com`,
    password: await bcrypt.hash("Password123!", 10),
  });
  adminIds.push(admin.id);
  licensed = await TradesType.create({ name: `${TAG} Licensed`, category: "Test", isActive: true, licenceRequired: true });
  plain = await TradesType.create({ name: `${TAG} Plain`, category: "Test", isActive: true });
  tradeIds.push(licensed.id, plain.id);
});

test.after(async () => {
  await EmailNotificationLog.destroy({ where: { tradesmanId: userIds } });
  await UserSubscription.destroy({ where: { userId: userIds } });
  await TradesmanDetails.destroy({ where: { userId: userIds } });
  await User.destroy({ where: { id: userIds } });
  await TradesType.destroy({ where: { id: tradeIds } });
  await Admin.destroy({ where: { id: adminIds } });
  await sequelize.close();
});

test("a licence-required tradesman who subscribes (even on a trial) gets every admin emailed once", async () => {
  const user = await makeTradesman("licensed", licensed);

  await handleTradesmanSubscribed(user.id);
  const first = mailAbout(user).length;
  assert.ok(first >= 1, "at least the test admin is emailed");

  await handleTradesmanSubscribed(user.id); // webhook retry, daily re-sync...
  assert.equal(mailAbout(user).length, first, "no second copy");

  const details = await TradesmanDetails.findOne({ where: { userId: user.id } });
  assert.equal(details.isApproved, false, "still waiting for an admin");
});

test("an unlicensed tradesman is approved on subscribing and no admin is emailed", async () => {
  const user = await makeTradesman("plain", plain);

  await handleTradesmanSubscribed(user.id);

  assert.equal(mailAbout(user).length, 0);
  const details = await TradesmanDetails.findOne({ where: { userId: user.id } });
  assert.equal(details.isApproved, true);
});
