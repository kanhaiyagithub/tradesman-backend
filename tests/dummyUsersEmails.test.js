const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const bcrypt = require("bcryptjs");
const nodemailer = require("nodemailer");

// Capture outgoing mail instead of sending it. Must happen before anything loads nodemailer.
const sentMail = [];
const fakeTransport = {
  sendMail: async (message) => {
    sentMail.push(message);
    return { messageId: `test-${sentMail.length}` };
  },
  verify: (cb) => (cb ? cb(null, true) : Promise.resolve(true)),
};
nodemailer.createTransport = () => fakeTransport;
process.env.SMTP_HOST = "smtp.test.local";
process.env.SMTP_PORT = "587";
process.env.SMTP_USER = "test";
process.env.SMTP_PASS = "test";
process.env.SMTP_FROM = "Touring Trades <no-reply@test.local>";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";

const app = require("../app");
const sequelize = require("../config/db");
const User = require("../models/User");
const Admin = require("../models/AdminModel/adminModel");
const TradesmanDetails = require("../models/TradesmanDetails");
const TradesType = require("../models/tradesTypeModel");
const EmailNotificationLog = require("../models/EmailNotificationLog");
const { isUndeliverableAddress } = require("../utils/emailAddress");
const { sendTradesmanApprovedEmail } = require("../services/emailService");
const { notifyAdminsTradesmanNeedsVerification } = require("../services/adminNotificationService");
const metaConversionService = require("../services/metaConversionService");

const suffix = `${Date.now()}-${process.pid}`;
const userIds = [];
let admin;
let server;
let baseUrl;

const makeUser = async (label, email, extra = {}) => {
  const user = await User.create({
    name: `Mail ${label}`,
    email,
    mobile: "0411111111",
    password: await bcrypt.hash("Password123!", 10),
    role: "client",
    provider: "manual",
    ...extra,
  });
  userIds.push(user.id);
  return user;
};

test.before(async () => {
  await sequelize.authenticate();
  admin = await Admin.create({
    name: "Mail Admin",
    email: `mail-admin-${suffix}@test.com`,
    password: await bcrypt.hash("Password123!", 10),
  });
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.beforeEach(() => {
  sentMail.length = 0;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await EmailNotificationLog.destroy({ where: { recipientUserId: userIds } });
  await TradesmanDetails.destroy({ where: { userId: userIds } });
  await User.destroy({ where: { id: userIds } });
  await Admin.destroy({ where: { id: admin.id } });
  await sequelize.close();
});

test("addresses that can never receive mail are recognised", () => {
  for (const undeliverable of [
    "a@mailbox.test",
    "a@MAILBOX.TEST",
    "a@sub.mailbox.test",
    "a@dummy.example",
    "a@x.invalid",
    "a@host.localhost",
    "a@printer.local",
    "Name <a@example.test>",
    "a@example.test.",
    ["a@one.test", "b@two.test"],
    "a@one.test, b@two.invalid",
  ]) {
    assert.equal(isUndeliverableAddress(undeliverable), true, JSON.stringify(undeliverable));
  }

  for (const deliverable of [
    "you@gmail.com",
    "you+d1@gmail.com",
    "a@test.com", // a real, registered domain (the test suite uses it with a mocked transport)
    "sam@example.com", // unchanged behaviour: existing tests and any real use of example.com are not touched
    "a@example.net",
    "a@example.org",
    "a@example.com.au",
    "a@notexample.com",
    "a@exampletest",
    "",
    null,
    undefined,
    ["a@one.test", "real@gmail.com"], // one real recipient is enough to send
  ]) {
    assert.equal(isUndeliverableAddress(deliverable), false, JSON.stringify(deliverable));
  }
});

test("no email is sent, and nothing is logged as failed, for a test address", async () => {
  const dummy = await makeUser("dummy", `mail-${suffix}@example.test`, { isDummy: true });

  const result = await sendTradesmanApprovedEmail({ user: dummy, businessName: "Test Co" });

  assert.equal(result.success, false);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "UNDELIVERABLE_TEST_ADDRESS");
  assert.equal(sentMail.length, 0);
  assert.equal(await EmailNotificationLog.count({ where: { recipientUserId: dummy.id } }), 0, "no failed log to retry");
});

test("a test account with a real inbox still receives emails, so tester can try them", async () => {
  const dummy = await makeUser("real-inbox", `mail-real-${suffix}@test.com`, { isDummy: true });

  const result = await sendTradesmanApprovedEmail({ user: dummy, businessName: "Test Co" });

  assert.equal(result.success, true);
  assert.equal(sentMail.length, 1);
  assert.equal(sentMail[0].to, dummy.email);
});

test("forgot-password for a test address sends nothing but answers like any other account", async () => {
  const dummy = await makeUser("forgot", `mail-forgot-${suffix}@example.test`, { isDummy: true });

  const response = await fetch(`${baseUrl}/api/users/forgot-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: dummy.email }),
  });

  assert.equal(response.status, 200);
  assert.equal(sentMail.length, 0);
});

test("a test tradesman never triggers admin verification emails or alerts", async () => {
  const trade = await TradesType.findOne();
  const dummy = await makeUser("tradie", `mail-tradie-${suffix}@example.test`, { isDummy: true, role: "tradesman" });
  await TradesmanDetails.create({
    userId: dummy.id,
    tradeType: trade.name,
    tradeTypeId: trade.id,
    businessName: "Test Plumbing",
    isApproved: false,
    verificationStatus: "pending",
  });

  const result = await notifyAdminsTradesmanNeedsVerification({ userId: dummy.id });

  assert.deepEqual(result, { notified: 0, reason: "DUMMY_USER" });
  assert.equal(sentMail.length, 0);
});

test("test accounts are never sent to Meta", async () => {
  const outcome = await metaConversionService.trackRegistration({
    user: { id: 1, role: "client", email: "x@example.test", isDummy: true },
    method: "email",
  });
  assert.deepEqual(outcome, { tracked: false, reason: "dummy" });
});
