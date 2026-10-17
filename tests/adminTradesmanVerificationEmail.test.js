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
process.env.ADMIN_PANEL_URL = "https://admin.test.local/";

const http = require("node:http");
const jwt = require("jsonwebtoken");

const app = require("../app");
const sequelize = require("../config/db");
const Notification = require("../models/notificationModel");
const Admin = require("../models/AdminModel/adminModel");
const User = require("../models/User");
const TradesmanDetails = require("../models/TradesmanDetails");
const TradesType = require("../models/tradesTypeModel");
const SubscriptionPlan = require("../models/SubscriptionPlan");
const UserSubscription = require("../models/UserSubscription");
const EmailNotificationLog = require("../models/EmailNotificationLog");
const {
  buildAdminTradesmanVerificationEmail,
  buildTradesmanApprovedEmail,
} = require("../services/emailService");
const {
  notifyAdminsTradesmanNeedsVerification,
} = require("../services/adminNotificationService");

const uniqueSuffix = `${Date.now()}-${process.pid}`;
const created = { users: [], admins: [] };

const makeAdmin = async (label) => {
  const admin = await Admin.create({
    name: `Verify Admin ${label}`,
    email: `verify-admin-${label}-${uniqueSuffix}@test.com`,
    password: await bcrypt.hash("Password123!", 10),
  });
  created.admins.push(admin.id);
  return admin;
};

const makeUser = async ({ role = "tradesman", approved = false, label }) => {
  const trade = await TradesType.findOne();
  assert.ok(trade, "a trade type seed is required");

  const user = await User.create({
    name: `Notify <${label}>`,
    email: `notify-${label}-${uniqueSuffix}@test.com`,
    mobile: "0411111111",
    password: await bcrypt.hash("Password123!", 10),
    role,
    provider: "manual",
    isVerified: true,
  });
  created.users.push(user.id);

  if (role === "tradesman") {
    await TradesmanDetails.create({
      userId: user.id,
      tradeType: trade.name,
      tradeTypeId: trade.id,
      businessName: "Notify Plumbing",
      shortBio: "bio",
      licenseNumber: "LIC-123",
      licenseExpiry: new Date("2030-12-31"),
      isApproved: approved,
    });
  }

  return user;
};

const giveSubscription = async (userId, status = "active") => {
  const plan = await SubscriptionPlan.findOne();
  assert.ok(plan, "a subscription plan seed is required");
  return UserSubscription.create({
    userId,
    planId: plan.id,
    status,
    currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  });
};

test.beforeEach(() => {
  sentMail.length = 0;
});

test.after(async () => {
  await UserSubscription.destroy({ where: { userId: created.users } });
  await EmailNotificationLog.destroy({ where: { tradesmanId: created.users } });
  await TradesmanDetails.destroy({ where: { userId: created.users } });
  await User.destroy({ where: { id: created.users } });
  await Admin.destroy({ where: { id: created.admins } });
  await sequelize.close();
});

test("email lists tradesman details, escapes HTML and links to the review page", () => {
  const email = buildAdminTradesmanVerificationEmail({
    admin: { name: "Alex" },
    tradesman: { name: "<b>Bad</b>", email: "t@test.com", mobile: "0400" },
    details: { businessName: "Acme", licenseNumber: "L1", portfolioPhotos: [] },
    planName: "Pro",
    reviewUrl: "https://admin.test.local/tradesmen/9",
  });

  assert.match(email.subject, /verify new tradesman/i);
  assert.ok(email.html.includes("&lt;b&gt;Bad&lt;/b&gt;"));
  assert.ok(!email.html.includes("<b>Bad</b>"));
  assert.ok(email.html.includes("https://admin.test.local/tradesmen/9"));
  assert.match(email.text, /Portfolio photos: Missing/);
});

test("every admin is emailed once when a pending tradesman subscribes", async () => {
  const adminOne = await makeAdmin("one");
  const adminTwo = await makeAdmin("two");
  const tradesman = await makeUser({ label: "pending" });

  const first = await notifyAdminsTradesmanNeedsVerification({
    userId: tradesman.id,
    planName: "Pro",
  });
  assert.ok(first.notified >= 2);

  const recipients = sentMail.map((mail) => mail.to);
  assert.ok(recipients.includes(adminOne.email));
  assert.ok(recipients.includes(adminTwo.email));
  assert.ok(sentMail.every((mail) => mail.html.includes("Notify Plumbing")));

  // A retried webhook must not send a second copy.
  sentMail.length = 0;
  const retry = await notifyAdminsTradesmanNeedsVerification({ userId: tradesman.id });
  assert.equal(retry.notified, 0);
  assert.equal(sentMail.length, 0);
});

test("no email for approved tradesmen or non-tradesmen", async () => {
  await makeAdmin("skip");
  const approved = await makeUser({ label: "approved", approved: true });
  const client = await makeUser({ label: "client", role: "client" });

  const approvedResult = await notifyAdminsTradesmanNeedsVerification({ userId: approved.id });
  const clientResult = await notifyAdminsTradesmanNeedsVerification({ userId: client.id });

  assert.equal(approvedResult.notified, 0);
  assert.equal(clientResult.notified, 0);
  assert.equal(sentMail.length, 0);
});

test("approved email congratulates the tradesman and escapes HTML", () => {
  const email = buildTradesmanApprovedEmail({
    user: { name: "<i>Sam</i>" },
    businessName: "Acme & Sons",
  });

  assert.match(email.subject, /Congratulations/);
  assert.ok(email.html.includes("&lt;i&gt;Sam&lt;/i&gt;"));
  assert.ok(email.html.includes("Acme &amp; Sons"));
  assert.match(email.text, /verified and approved/);
});

test("approving a tradesman emails them and creates an in-app notification", async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret";
  const admin = await makeAdmin("approver");
  const tradesman = await makeUser({ label: "toapprove" });
  await TradesmanDetails.update(
    { licenseDocument: "licence.pdf", portfolioPhotos: ["photo.jpg"] },
    { where: { userId: tradesman.id } }
  );

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const token = jwt.sign({ id: admin.id, role: "admin" }, process.env.JWT_SECRET);
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/api/admin/tradesmen/${tradesman.id}/approve`,
      { method: "POST", headers: { Authorization: `Bearer ${token}` } }
    );
    assert.equal(response.status, 200);

    // The email is sent in the background; wait for it.
    for (let i = 0; i < 50 && !sentMail.some((m) => m.to === tradesman.email); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const mail = sentMail.find((m) => m.to === tradesman.email);
    assert.ok(mail, "approval email should be sent to the tradesman");
    assert.match(mail.subject, /Congratulations/);

    let notification = null;
    for (let i = 0; i < 50 && !notification; i += 1) {
      notification = await Notification.findOne({
        where: { userId: tradesman.id, type: "PROFILE_APPROVED" },
      });
      if (!notification) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(notification, "in-app notification should exist");
    await notification.destroy();
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("rejecting a tradesman requires a reason, then emails and notifies them", async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret";
  const admin = await makeAdmin("rejecter");
  const tradesman = await makeUser({ label: "toreject" });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const token = jwt.sign({ id: admin.id, role: "admin" }, process.env.JWT_SECRET);
    const reject = (body) =>
      fetch(
        `http://127.0.0.1:${server.address().port}/api/admin/tradesmen/${tradesman.id}/reject`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      );

    assert.equal((await reject({})).status, 400);
    assert.equal((await reject({ reason: "   " })).status, 400);
    assert.equal((await reject({ reason: "x".repeat(501) })).status, 400);

    const reason = "Licence photo is blurry <please resubmit>";
    assert.equal((await reject({ reason })).status, 200);

    for (let i = 0; i < 50 && !sentMail.some((m) => m.to === tradesman.email); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const mail = sentMail.find((m) => m.to === tradesman.email);
    assert.ok(mail, "rejection email should be sent to the tradesman");
    assert.ok(mail.text.includes(reason));
    assert.ok(mail.html.includes("Licence photo is blurry &lt;please resubmit&gt;"));

    let notification = null;
    for (let i = 0; i < 50 && !notification; i += 1) {
      notification = await Notification.findOne({
        where: { userId: tradesman.id, type: "PROFILE_REJECTED" },
      });
      if (!notification) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(notification, "in-app notification should exist");
    assert.ok(notification.body.includes(reason));
    await notification.destroy();
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("rejected tradesman: subscribing sends no email, resubmitting does, then approval works", async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret";
  const admin = await makeAdmin("lifecycle");
  const tradesman = await makeUser({ label: "lifecycle" });
  await TradesmanDetails.update(
    { licenseDocument: "licence.pdf", portfolioPhotos: ["photo.jpg"] },
    { where: { userId: tradesman.id } }
  );

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const adminToken = jwt.sign({ id: admin.id, role: "admin" }, process.env.JWT_SECRET);
  const userToken = jwt.sign(
    { id: tradesman.id, email: tradesman.email, role: "tradesman" },
    process.env.JWT_SECRET
  );
  const post = (path, token, body) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
  const adminMails = () => sentMail.filter((m) => m.to === admin.email);

  try {
    // Cannot resubmit before being rejected.
    assert.equal((await post("/api/users/profile/resubmit", userToken)).status, 400);

    // Rejected -> status moves to rejected.
    assert.equal(
      (await post(`/api/admin/tradesmen/${tradesman.id}/reject`, adminToken, { reason: "Blurry licence" })).status,
      200
    );
    assert.equal(
      (await TradesmanDetails.findOne({ where: { userId: tradesman.id } })).verificationStatus,
      "rejected"
    );
    // Rejecting twice is refused.
    assert.equal(
      (await post(`/api/admin/tradesmen/${tradesman.id}/reject`, adminToken, { reason: "again" })).status,
      400
    );

    // Subscribing while rejected must not ask admins to "verify a new tradesman".
    sentMail.length = 0;
    const subscribed = await notifyAdminsTradesmanNeedsVerification({ userId: tradesman.id });
    assert.equal(subscribed.notified, 0);
    assert.equal(subscribed.reason, "NOT_PENDING");
    assert.equal(adminMails().length, 0);

    // Approving a rejected tradesman is refused until they resubmit.
    assert.equal((await post(`/api/admin/tradesmen/${tradesman.id}/approve`, adminToken)).status, 400);

    // Resubmitting needs an active subscription.
    assert.equal((await post("/api/users/profile/resubmit", userToken)).status, 403);
    await giveSubscription(tradesman.id);

    // Resubmitting emails the admin, mentioning the previous reason.
    const resubmit = await post("/api/users/profile/resubmit", userToken);
    assert.equal(resubmit.status, 200);
    for (let i = 0; i < 50 && adminMails().length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const mail = adminMails()[0];
    assert.ok(mail, "admin should be emailed about the resubmission");
    assert.match(mail.subject, /resubmitted/i);
    assert.ok(mail.text.includes("Blurry licence"));
    assert.equal(
      (await TradesmanDetails.findOne({ where: { userId: tradesman.id } })).verificationStatus,
      "resubmitted"
    );

    // Resubmitted profile shows up in the admin queue and can be approved.
    const pending = await fetch(
      `${base}/api/admin/tradesmen/pending?search=${encodeURIComponent(tradesman.email)}`,
      { headers: { Authorization: `Bearer ${adminToken}` } }
    ).then((r) => r.json());
    assert.equal(pending.data.meta.total, 1);

    assert.equal((await post(`/api/admin/tradesmen/${tradesman.id}/approve`, adminToken)).status, 200);
    const final = await TradesmanDetails.findOne({ where: { userId: tradesman.id } });
    assert.equal(final.verificationStatus, "approved");
    assert.equal(final.isApproved, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await Notification.destroy({ where: { userId: tradesman.id } });
  }
});

test("admin queue and dashboard count only subscribed tradesmen", async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret";
  const admin = await makeAdmin("queue");
  const subscribed = await makeUser({ label: "queue-subscribed" });
  const unsubscribed = await makeUser({ label: "queue-unsubscribed" });
  const lapsed = await makeUser({ label: "queue-lapsed" });
  await giveSubscription(subscribed.id);
  await giveSubscription(lapsed.id, "canceled");

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const adminToken = jwt.sign({ id: admin.id, role: "admin" }, process.env.JWT_SECRET);
  const get = (path) =>
    fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${adminToken}` } }).then((r) => r.json());
  const emailsIn = (response) => response.data.data.map((row) => row.user.email);

  try {
    const marker = `-${uniqueSuffix}@test.com`;
    const defaultQueue = await get(`/api/admin/tradesmen/pending?limit=100&search=${encodeURIComponent("notify-queue-")}`);
    const defaultEmails = emailsIn(defaultQueue).filter((email) => email.endsWith(marker));
    assert.deepEqual(defaultEmails, [subscribed.email]);

    const everyone = await get(
      `/api/admin/tradesmen/pending?limit=100&includeUnsubscribed=true&search=${encodeURIComponent("notify-queue-")}`
    );
    const everyoneEmails = emailsIn(everyone).filter((email) => email.endsWith(marker));
    assert.deepEqual(everyoneEmails.sort(), [subscribed.email, unsubscribed.email, lapsed.email].sort());

    // Dashboard pending count includes the subscribed tradesman only.
    const before = (await get("/api/admin/dashboard/summary")).data.tradesmen.pendingApprovals;
    await giveSubscription(unsubscribed.id);
    const after = (await get("/api/admin/dashboard/summary")).data.tradesmen.pendingApprovals;
    assert.equal(after, before + 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
