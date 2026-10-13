const assert = require("node:assert/strict");
const test = require("node:test");

// Dead DB + fake secrets BEFORE anything loads config/db, Stripe or nodemailer:
// nothing here can reach a real database, SMTP server, Stripe or Meta.
process.env.DB_HOST = "127.0.0.1";
process.env.DB_PORT = "1";
process.env.DB_NAME = "sub_email_test_unused";
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

// Stub the push sender so these tests never touch Firebase or the database.
const notificationService = require("../services/notificationService");
notificationService.createAndSendNotification = async () => ({ success: true });

const { Op } = require("sequelize");
const Stripe = require("stripe");
const User = require("../models/User");
const SubscriptionPlan = require("../models/SubscriptionPlan");
const UserSubscription = require("../models/UserSubscription");
const StripeWebhookEvent = require("../models/StripeWebhookEvent");
const EmailNotificationLog = require("../models/EmailNotificationLog");
const webhook = require("../controllers/stripeWebhookController");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const saved = {
  userFindByPk: User.findByPk,
  planFindByPk: SubscriptionPlan.findByPk,
  planFindOne: SubscriptionPlan.findOne,
  subFindOne: UserSubscription.findOne,
  subUpdate: UserSubscription.update,
  eventFindOrCreate: StripeWebhookEvent.findOrCreate,
  eventUpdate: StripeWebhookEvent.update,
  logFindOne: EmailNotificationLog.findOne,
  logCreate: EmailNotificationLog.create,
  consoleLog: console.log,
  consoleError: console.error,
};

let user;
let localRow;
let emailLogs;
let logFindShouldThrow;
let eventCounter = 0;

const PERIOD_END_UNIX = Math.floor(new Date("2026-11-10T12:00:00Z").getTime() / 1000);

test.beforeEach(() => {
  process.env.SUBSCRIPTION_EMAILS_ENABLED = "true";
  sentEmails.length = 0;
  transportShouldFail = false;
  logFindShouldThrow = false;
  emailLogs = [];

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
  UserSubscription.update = async () => [1];
  UserSubscription.findOne = async ({ where }) => {
    const conditions = where[Op.or] || [];
    const match = conditions.some(
      (condition) =>
        (condition.stripeSubscriptionId && condition.stripeSubscriptionId === localRow.stripeSubscriptionId) ||
        (condition.stripeCustomerId && condition.stripeCustomerId === localRow.stripeCustomerId)
    );
    return match ? localRow : null;
  };

  StripeWebhookEvent.findOrCreate = async () => [{ status: "processing", update: async () => {} }, true];
  StripeWebhookEvent.update = async () => [1];

  EmailNotificationLog.findOne = async ({ where }) => {
    if (logFindShouldThrow) throw new Error("log table missing");
    return (
      emailLogs.find(
        (log) => log.type === where.type && log.recipientUserId === where.recipientUserId
      ) || null
    );
  };
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
  UserSubscription.update = saved.subUpdate;
  StripeWebhookEvent.findOrCreate = saved.eventFindOrCreate;
  StripeWebhookEvent.update = saved.eventUpdate;
  EmailNotificationLog.findOne = saved.logFindOne;
  EmailNotificationLog.create = saved.logCreate;
  console.log = saved.consoleLog;
  console.error = saved.consoleError;
  delete process.env.SUBSCRIPTION_EMAILS_ENABLED;
});

/** Sends a properly signed event through the real webhook handler. */
const sendEvent = async (type, object, { id } = {}) => {
  eventCounter += 1;
  const payload = JSON.stringify({
    id: id || `evt_email_${eventCounter}`,
    object: "event",
    type,
    data: { object },
  });

  const signature = stripe.webhooks.generateTestHeaderString({
    payload,
    secret: process.env.STRIPE_WEBHOOK_SECRET,
  });

  const response = { statusCode: 200, body: null };
  const res = {
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
  };

  await webhook.handleWebhook(
    { headers: { "stripe-signature": signature }, body: Buffer.from(payload) },
    res
  );

  return response;
};

const invoice = (overrides = {}) => ({
  id: "in_1",
  object: "invoice",
  billing_reason: "subscription_create",
  amount_paid: 4400,
  currency: "aud",
  customer: "cus_1",
  parent: { type: "subscription_details", subscription_details: { subscription: "sub_123" } },
  lines: { data: [{ description: "Make Money", period: { end: PERIOD_END_UNIX } }] },
  ...overrides,
});

const stripeSubscription = (overrides = {}) => ({
  id: "sub_123",
  object: "subscription",
  customer: "cus_1",
  status: "active",
  cancel_at_period_end: false,
  items: { data: [{ price: { id: "price_1" }, current_period_start: 1700000000, current_period_end: PERIOD_END_UNIX }] },
  ...overrides,
});

// ----------------------------------------------------------------- welcome

test("welcome email is sent for the first paid invoice with plan, amount and renewal date", async () => {
  const response = await sendEvent("invoice.paid", invoice());

  assert.equal(response.statusCode, 200);
  assert.equal(sentEmails.length, 1);

  const email = sentEmails[0];
  assert.equal(email.to, "sam@example.com");
  assert.equal(email.from, process.env.SMTP_FROM);
  assert.match(email.subject, /Welcome to Touring Trades/);
  assert.match(email.text, /Hi Sam Sparks,/);
  assert.match(email.text, /Make Money/);
  assert.match(email.text, /\$44\.00/);
  assert.match(email.text, /10 November 2026/);
  assert.match(email.html, /Make Money/);
});

test("welcome email is not sent for a renewal or a $0 first invoice", async () => {
  await sendEvent("invoice.paid", invoice({ billing_reason: "subscription_cycle" }));
  await sendEvent("invoice.paid", invoice({ amount_paid: 0 }));
  await sendEvent("invoice.paid", invoice({ billing_reason: "subscription_update" }));

  assert.equal(sentEmails.length, 0);
});

test("a re-delivered or retried event cannot send a second welcome email", async () => {
  await sendEvent("invoice.paid", invoice(), { id: "evt_same" });
  assert.equal(sentEmails.length, 1);

  // Same event id again, now marked "failed" so the handler reprocesses it.
  StripeWebhookEvent.findOrCreate = async () => [{ status: "failed", update: async () => {} }, false];
  await sendEvent("invoice.paid", invoice(), { id: "evt_same" });

  // A different event for the same subscription (e.g. a second delivery path).
  await sendEvent("invoice.paid", invoice({ id: "in_other" }));

  assert.equal(sentEmails.length, 1);
});

test("welcome email still works when only the invoice metadata knows the user", async () => {
  localRow = { ...localRow, stripeSubscriptionId: "sub_unrelated", stripeCustomerId: "cus_unrelated" };

  await sendEvent(
    "invoice.paid",
    invoice({ parent: { subscription_details: { subscription: "sub_123", metadata: { userId: "7" } } } })
  );

  assert.equal(sentEmails.length, 1);
  assert.match(sentEmails[0].text, /Make Money/);
});

// ----------------------------------------------------------- payment failed

test("payment-failed email asks for a new card and contains no link", async () => {
  await sendEvent(
    "invoice.payment_failed",
    invoice({ billing_reason: "subscription_cycle", attempt_count: 1, next_payment_attempt: PERIOD_END_UNIX })
  );

  assert.equal(sentEmails.length, 1);
  const { text, html, subject } = sentEmails[0];
  assert.match(subject, /payment failed/i);
  assert.match(text, /update your card/i);
  assert.match(text, /access continues while Stripe retries/i);
  assert.match(text, /open the Touring Trades app and tap the payment notification/);
  assert.doesNotMatch(text, /https?:\/\//);
  assert.doesNotMatch(html, /https?:\/\//);
  assert.doesNotMatch(html, /<a /);
});

test("payment-failed email is not sent for subscription_create", async () => {
  await sendEvent("invoice.payment_failed", invoice({ billing_reason: "subscription_create" }));

  assert.equal(sentEmails.length, 0);
});

test("each failed retry attempt gets its own email, but a redelivery does not", async () => {
  const failed = (attempt) =>
    invoice({ billing_reason: "subscription_cycle", id: "in_cycle", attempt_count: attempt });

  await sendEvent("invoice.payment_failed", failed(1));
  await sendEvent("invoice.payment_failed", failed(1));
  await sendEvent("invoice.payment_failed", failed(2));

  assert.equal(sentEmails.length, 2);
});

// -------------------------------------------------------- cancel scheduled

test("cancellation-scheduled email is sent only on the false -> true change, with the end date", async () => {
  localRow.cancelAtPeriodEnd = false;
  await sendEvent("customer.subscription.updated", stripeSubscription({ cancel_at_period_end: true }));

  assert.equal(sentEmails.length, 1);
  assert.match(sentEmails[0].subject, /cancellation is scheduled/i);
  assert.match(sentEmails[0].text, /10 November 2026/);
  assert.equal(localRow.cancelAtPeriodEnd, true, "the row is still synced");
});

test("no cancellation email when it was already scheduled, or when cancel is not set", async () => {
  localRow.cancelAtPeriodEnd = true;
  await sendEvent("customer.subscription.updated", stripeSubscription({ cancel_at_period_end: true }));
  assert.equal(sentEmails.length, 0);

  localRow.cancelAtPeriodEnd = false;
  await sendEvent("customer.subscription.updated", stripeSubscription({ cancel_at_period_end: false }));
  assert.equal(sentEmails.length, 0);

  // true -> false (user kept their plan) is not an email either.
  localRow.cancelAtPeriodEnd = true;
  await sendEvent("customer.subscription.updated", stripeSubscription({ cancel_at_period_end: false }));
  assert.equal(sentEmails.length, 0);
});

// ------------------------------------------------------------------- ended

test("subscription-ended email is sent when an update shows canceled", async () => {
  await sendEvent("customer.subscription.updated", stripeSubscription({ status: "canceled" }));

  assert.equal(sentEmails.length, 1);
  assert.match(sentEmails[0].subject, /plan has ended/i);
  assert.match(sentEmails[0].text, /resubscribe/i);
  assert.equal(localRow.status, "canceled");
});

test("subscription-ended email is sent on customer.subscription.deleted, once", async () => {
  await sendEvent("customer.subscription.deleted", stripeSubscription());
  assert.equal(sentEmails.length, 1);

  // A later updated->canceled for the same subscription sees a canceled row.
  await sendEvent("customer.subscription.updated", stripeSubscription({ status: "canceled" }));
  assert.equal(sentEmails.length, 1);
});

test("no ended email for a subscription that never had access", async () => {
  localRow.status = "incomplete";

  await sendEvent("customer.subscription.updated", stripeSubscription({ status: "canceled" }));

  assert.equal(sentEmails.length, 0);
});

// ------------------------------------------------------ failures and flag

test("an SMTP failure does not fail the webhook", async () => {
  transportShouldFail = true;

  const response = await sendEvent("invoice.paid", invoice());

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { received: true });
  assert.equal(sentEmails.length, 0);
});

test("a database failure while logging the email does not fail the webhook", async () => {
  logFindShouldThrow = true;

  const response = await sendEvent("invoice.paid", invoice());

  assert.equal(response.statusCode, 200);
  assert.equal(sentEmails.length, 0);
});

test("a failure loading the user does not fail the webhook", async () => {
  User.findByPk = async () => {
    throw new Error("db down");
  };

  const response = await sendEvent("customer.subscription.updated", stripeSubscription({ cancel_at_period_end: true }));

  assert.equal(response.statusCode, 200);
  assert.equal(sentEmails.length, 0);
});

test("no email is sent when the user has no email address", async () => {
  user = { id: 7, name: "No Email", email: null };

  await sendEvent("invoice.paid", invoice());
  await sendEvent("customer.subscription.deleted", stripeSubscription());

  assert.equal(sentEmails.length, 0);
});

test("SUBSCRIPTION_EMAILS_ENABLED=false switches off all four emails", async () => {
  process.env.SUBSCRIPTION_EMAILS_ENABLED = "false";

  await sendEvent("invoice.paid", invoice());
  await sendEvent("invoice.payment_failed", invoice({ billing_reason: "subscription_cycle" }));
  localRow.cancelAtPeriodEnd = false;
  await sendEvent("customer.subscription.updated", stripeSubscription({ cancel_at_period_end: true }));
  await sendEvent("customer.subscription.deleted", stripeSubscription());

  assert.equal(sentEmails.length, 0);
});

test("the emails are on by default when the flag is not set", async () => {
  delete process.env.SUBSCRIPTION_EMAILS_ENABLED;

  await sendEvent("invoice.paid", invoice());

  assert.equal(sentEmails.length, 1);
});
