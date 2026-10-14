const assert = require("node:assert/strict");
const test = require("node:test");

// Dead DB + fake secrets BEFORE anything loads config/db or Stripe, so nothing
// here can reach a real database or the real Stripe/Meta APIs.
process.env.DB_HOST = "127.0.0.1";
process.env.DB_PORT = "1";
process.env.DB_NAME = "invoice_paid_test_unused";
process.env.DB_USER = "unused";
process.env.DB_PASS = "unused";
process.env.STRIPE_SECRET_KEY = "sk_test_fake_not_real";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_fake_test_secret";
process.env.META_CAPI_ENABLED = "false";

// Replace the Stripe client so the customer lookup in the sync never hits the network.
const RealStripe = require("stripe");
function FakeStripe(key) {
  const client = new RealStripe(key);
  client.customers.retrieve = async (id) => ({ id, metadata: {} });
  return client;
}
require.cache[require.resolve("stripe")].exports = FakeStripe;
const Stripe = FakeStripe;
const UserSubscription = require("../models/UserSubscription");
const StripeWebhookEvent = require("../models/StripeWebhookEvent");
const webhook = require("../controllers/stripeWebhookController");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const saved = {
  update: UserSubscription.update,
  findOrCreate: StripeWebhookEvent.findOrCreate,
  consoleLog: console.log,
  consoleError: console.error,
};

let rows;
let updateCalls;
let eventCounter = 0;

test.beforeEach(() => {
  rows = [
    { stripeSubscriptionId: "sub_123", status: "past_due" },
    { stripeSubscriptionId: "sub_other", status: "past_due" },
  ];
  updateCalls = 0;

  // Applies the update to the in-memory rows like the real where-clause would.
  UserSubscription.update = async (values, { where }) => {
    updateCalls += 1;
    rows
      .filter((row) => row.stripeSubscriptionId === where.stripeSubscriptionId)
      .forEach((row) => Object.assign(row, values));
    return [1];
  };

  StripeWebhookEvent.findOrCreate = async () => [{ update: async () => {} }, true];
  StripeWebhookEvent.update = async () => [1];
  console.log = () => {};
  console.error = () => {};
});

test.afterEach(() => {
  UserSubscription.update = saved.update;
  StripeWebhookEvent.findOrCreate = saved.findOrCreate;
  console.log = saved.consoleLog;
  console.error = saved.consoleError;
});

/** Sends a properly signed invoice.paid event through the real handler. */
const sendInvoicePaid = async (invoice) => {
  eventCounter += 1;
  const payload = JSON.stringify({
    id: `evt_test_${eventCounter}`,
    object: "event",
    type: "invoice.paid",
    data: { object: { id: "in_1", object: "invoice", amount_paid: 0, ...invoice } },
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

const statusOf = (subscriptionId) =>
  rows.find((row) => row.stripeSubscriptionId === subscriptionId).status;

test("invoice.paid with the old shape (invoice.subscription) activates the subscription", async () => {
  const response = await sendInvoicePaid({ subscription: "sub_123" });

  assert.equal(response.statusCode, 200);
  assert.equal(statusOf("sub_123"), "active");
  assert.equal(statusOf("sub_other"), "past_due", "other subscriptions must be untouched");
});

test("invoice.paid with the new shape (invoice.parent.subscription_details) activates the subscription", async () => {
  const response = await sendInvoicePaid({
    parent: { type: "subscription_details", subscription_details: { subscription: "sub_123" } },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(statusOf("sub_123"), "active");
  assert.equal(statusOf("sub_other"), "past_due", "other subscriptions must be untouched");
});

test("invoice.paid with an expanded subscription object uses its id", async () => {
  await sendInvoicePaid({ parent: { subscription_details: { subscription: { id: "sub_123" } } } });

  assert.equal(statusOf("sub_123"), "active");
  assert.equal(statusOf("sub_other"), "past_due");
});

test("invoice.paid with no subscription id updates nothing and does not throw", async () => {
  const response = await sendInvoicePaid({});

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { received: true });
  assert.equal(updateCalls, 0);
  assert.equal(statusOf("sub_123"), "past_due");
  assert.equal(statusOf("sub_other"), "past_due");
});

test("a subscription whose mapped user does not exist is skipped, not a webhook failure", async () => {
  const SubscriptionPlan = require("../models/SubscriptionPlan");
  const User = require("../models/User");
  const originals = {
    subFindOne: UserSubscription.findOne,
    subCreate: UserSubscription.create,
    planFindOne: SubscriptionPlan.findOne,
    userFindByPk: User.findByPk,
  };

  let created = false;
  UserSubscription.findOne = async () => null; // no local row yet
  UserSubscription.create = async () => {
    created = true;
    const error = new Error("FOREIGN KEY constraint fails");
    error.name = "SequelizeForeignKeyConstraintError";
    throw error;
  };
  SubscriptionPlan.findOne = async () => ({ id: 2 });
  User.findByPk = async () => null; // user 123 is not in this database

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);

  try {
    // customer.subscription.created whose customer metadata points at user 123
    await webhook._private.syncSubscriptionFromStripe({
      id: "sub_x",
      customer: { id: "cus_x" },
      status: "incomplete",
      metadata: { userId: "123", planId: "2" },
      items: { data: [{ price: { id: "price_1" } }] },
    });
  } finally {
    UserSubscription.findOne = originals.subFindOne;
    UserSubscription.create = originals.subCreate;
    SubscriptionPlan.findOne = originals.planFindOne;
    User.findByPk = originals.userFindByPk;
    console.warn = originalWarn;
  }

  assert.equal(created, false, "must not try to create a row for a missing user");
  assert.equal(warnings.length, 1);
});
