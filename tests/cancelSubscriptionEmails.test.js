const assert = require("node:assert/strict");
const test = require("node:test");

// Dead DB + fake secrets BEFORE anything loads config/db, Stripe or nodemailer:
// nothing here can reach a real database, SMTP server or Stripe.
process.env.DB_HOST = "127.0.0.1";
process.env.DB_PORT = "1";
process.env.DB_NAME = "cancel_email_test_unused";
process.env.DB_USER = "unused";
process.env.DB_PASS = "unused";
process.env.STRIPE_SECRET_KEY = "sk_test_fake_not_real";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_fake_test_secret";
process.env.META_CAPI_ENABLED = "false";
process.env.SMTP_HOST = "smtp.fake.invalid";
process.env.SMTP_PORT = "587";
process.env.SMTP_USER = "fake-user";
process.env.SMTP_PASS = "fake-pass";
process.env.SMTP_FROM = "Touring Trades <noreply@fake.invalid>";

// Fake email sender: replaces the SMTP transport before emailService loads.
const sentEmails = [];
let transportShouldFail = false;
const nodemailer = require("nodemailer");
nodemailer.createTransport = () => ({
  sendMail: async (message) => {
    if (transportShouldFail) throw new Error("smtp down");
    sentEmails.push(message);
    return { messageId: `msg_${sentEmails.length}` };
  },
});

// Fake Stripe API calls made by the cancel endpoint; everything else stays real
// (the webhook needs the real signature helpers).
let stripeResult;
let stripeCalls;
const RealStripe = require("stripe");
function FakeStripe(key) {
  const client = new RealStripe(key);
  client.subscriptions.update = async (id, params) => {
    stripeCalls.push(["update", id, params]);
    return stripeResult;
  };
  client.subscriptions.cancel = async (id) => {
    stripeCalls.push(["cancel", id]);
    return stripeResult;
  };
  return client;
}
require.cache[require.resolve("stripe")].exports = FakeStripe;

const notificationService = require("../services/notificationService");
notificationService.createAndSendNotification = async () => ({ success: true });

const { Op } = require("sequelize");
const User = require("../models/User");
const SubscriptionPlan = require("../models/SubscriptionPlan");
const UserSubscription = require("../models/UserSubscription");
const StripeWebhookEvent = require("../models/StripeWebhookEvent");
const EmailNotificationLog = require("../models/EmailNotificationLog");
const subscriptionController = require("../controllers/subscriptionController");
const webhook = require("../controllers/stripeWebhookController");

const stripeForSigning = new RealStripe(process.env.STRIPE_SECRET_KEY);

const saved = {
  userFindByPk: User.findByPk,
  planFindByPk: SubscriptionPlan.findByPk,
  planFindOne: SubscriptionPlan.findOne,
  subFindOne: UserSubscription.findOne,
  eventFindOrCreate: StripeWebhookEvent.findOrCreate,
  eventUpdate: StripeWebhookEvent.update,
  logFindOne: EmailNotificationLog.findOne,
  logCreate: EmailNotificationLog.create,
  consoleLog: console.log,
  consoleError: console.error,
};

const PERIOD_END_UNIX = Math.floor(new Date("2026-11-10T12:00:00Z").getTime() / 1000);

let user;
let localRow;
let emailLogs;

test.beforeEach(() => {
  process.env.SUBSCRIPTION_EMAILS_ENABLED = "true";
  sentEmails.length = 0;
  transportShouldFail = false;
  stripeCalls = [];
  emailLogs = [];
  stripeResult = null;

  user = { id: 7, name: "Sam Sparks", email: "sam@example.com" };
  localRow = {
    userId: 7,
    planId: 3,
    stripeSubscriptionId: "sub_123",
    stripeCustomerId: "cus_1",
    status: "active",
    cancelAtPeriodEnd: false,
    currentPeriodEnd: new Date(PERIOD_END_UNIX * 1000),
    save: async () => {},
  };

  User.findByPk = async () => user;
  SubscriptionPlan.findByPk = async () => ({ id: 3, name: "Make Money" });
  SubscriptionPlan.findOne = async () => null;
  UserSubscription.findOne = async ({ where }) => {
    // Cancel endpoint: lookup by userId. Webhook: lookup by subscription/customer id.
    if (where.userId) return localRow;
    const conditions = where[Op.or] || [];
    const match = conditions.some(
      (condition) =>
        condition.stripeSubscriptionId === localRow.stripeSubscriptionId ||
        condition.stripeCustomerId === localRow.stripeCustomerId
    );
    return match ? localRow : null;
  };

  StripeWebhookEvent.findOrCreate = async () => [{ status: "processing", update: async () => {} }, true];
  StripeWebhookEvent.update = async () => [1];

  EmailNotificationLog.findOne = async ({ where }) =>
    emailLogs.find((log) => log.type === where.type && log.recipientUserId === where.recipientUserId) || null;
  EmailNotificationLog.create = async (payload) => {
    emailLogs.push({ ...payload, update: async () => {} });
  };

  console.log = () => {};
  console.error = () => {};
});

test.afterEach(() => {
  User.findByPk = saved.userFindByPk;
  SubscriptionPlan.findByPk = saved.planFindByPk;
  SubscriptionPlan.findOne = saved.planFindOne;
  UserSubscription.findOne = saved.subFindOne;
  StripeWebhookEvent.findOrCreate = saved.eventFindOrCreate;
  StripeWebhookEvent.update = saved.eventUpdate;
  EmailNotificationLog.findOne = saved.logFindOne;
  EmailNotificationLog.create = saved.logCreate;
  console.log = saved.consoleLog;
  console.error = saved.consoleError;
  delete process.env.SUBSCRIPTION_EMAILS_ENABLED;
});

const makeRes = () => {
  const response = { statusCode: 200, body: null };
  return {
    response,
    res: {
      status(code) {
        response.statusCode = code;
        return this;
      },
      json(body) {
        response.body = body;
        return this;
      },
      send(body) {
        response.body = body;
        return this;
      },
    },
  };
};

const cancelInApp = async (body = {}) => {
  const { res, response } = makeRes();
  await subscriptionController.cancelSubscription(
    { user: { id: 7, role: "tradesman" }, body },
    res
  );
  return response;
};

let eventCounter = 0;
const sendWebhook = async (type, object) => {
  eventCounter += 1;
  const payload = JSON.stringify({
    id: `evt_cancel_${eventCounter}`,
    object: "event",
    type,
    data: { object },
  });
  const signature = stripeForSigning.webhooks.generateTestHeaderString({
    payload,
    secret: process.env.STRIPE_WEBHOOK_SECRET,
  });
  const { res, response } = makeRes();
  await webhook.handleWebhook(
    { headers: { "stripe-signature": signature }, body: Buffer.from(payload) },
    res
  );
  return response;
};

const scheduledSubscription = () => ({
  id: "sub_123",
  object: "subscription",
  customer: "cus_1",
  status: "active",
  cancel_at_period_end: true,
  current_period_start: 1700000000,
  current_period_end: PERIOD_END_UNIX,
  items: { data: [{ price: { id: "price_1" }, current_period_end: PERIOD_END_UNIX }] },
});

const canceledSubscription = () => ({ ...scheduledSubscription(), status: "canceled", cancel_at_period_end: false });

test("in-app cancel at period end sends one scheduled email with the end date", async () => {
  stripeResult = scheduledSubscription();

  const response = await cancelInApp();

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.message, "Subscription will end at the current period end");
  assert.equal(stripeCalls[0][0], "update");
  assert.equal(sentEmails.length, 1);
  assert.equal(sentEmails[0].to, "sam@example.com");
  assert.match(sentEmails[0].subject, /cancellation is scheduled/i);
  assert.match(sentEmails[0].text, /10 November 2026/);
});

test("immediate in-app cancel sends one ended email", async () => {
  stripeResult = canceledSubscription();

  const response = await cancelInApp({ cancelImmediately: true });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.message, "Subscription canceled successfully");
  assert.equal(stripeCalls[0][0], "cancel");
  assert.equal(sentEmails.length, 1);
  assert.match(sentEmails[0].subject, /plan has ended/i);
  assert.match(sentEmails[0].text, /resubscribe/i);
});

test("the later webhook for an in-app scheduled cancel sends no second email", async () => {
  stripeResult = scheduledSubscription();
  await cancelInApp();
  assert.equal(sentEmails.length, 1);

  // Normal case: the local row already shows the cancel, so the webhook sees no change.
  await sendWebhook("customer.subscription.updated", scheduledSubscription());
  assert.equal(sentEmails.length, 1);

  // Even if the webhook compared against an old row, the once-only key blocks a duplicate.
  localRow.cancelAtPeriodEnd = false;
  await sendWebhook("customer.subscription.updated", scheduledSubscription());
  assert.equal(sentEmails.length, 1);
});

test("the later webhook for an in-app immediate cancel sends no second email", async () => {
  stripeResult = canceledSubscription();
  await cancelInApp({ cancelImmediately: true });
  assert.equal(sentEmails.length, 1);

  await sendWebhook("customer.subscription.deleted", canceledSubscription());
  await sendWebhook("customer.subscription.updated", canceledSubscription());
  assert.equal(sentEmails.length, 1);

  // Even if the webhook saw a not-yet-canceled row, the once-only key blocks a duplicate.
  localRow.status = "active";
  await sendWebhook("customer.subscription.deleted", canceledSubscription());
  assert.equal(sentEmails.length, 1);
});

test("an email failure still returns the normal success response", async () => {
  stripeResult = scheduledSubscription();
  transportShouldFail = true;

  const response = await cancelInApp();

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.success, true);
  assert.equal(response.body.message, "Subscription will end at the current period end");
  assert.equal(sentEmails.length, 0);
});

test("a failure loading the user for the email still returns the normal success response", async () => {
  stripeResult = canceledSubscription();
  User.findByPk = async () => {
    throw new Error("db down");
  };

  const response = await cancelInApp({ cancelImmediately: true });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.message, "Subscription canceled successfully");
  assert.equal(sentEmails.length, 0);
});

test("the cancel endpoint sends no email when the switch is off", async () => {
  process.env.SUBSCRIPTION_EMAILS_ENABLED = "false";
  stripeResult = scheduledSubscription();

  const response = await cancelInApp();

  assert.equal(response.statusCode, 200);
  assert.equal(sentEmails.length, 0);
});
