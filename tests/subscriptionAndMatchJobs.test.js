const assert = require("node:assert/strict");
const test = require("node:test");

// Dead DB + fake Stripe key BEFORE anything loads config/db or Stripe, so an
// un-mocked query or API call can never reach a real database or Stripe.
process.env.DB_HOST = "127.0.0.1";
process.env.DB_PORT = "1";
process.env.DB_NAME = "jobs_test_unused";
process.env.DB_USER = "unused";
process.env.DB_PASS = "unused";
process.env.STRIPE_SECRET_KEY = "sk_test_fake_not_real";

// Stub the notification senders before the services destructure them.
const pushService = require("../services/pushNotificationService");
const notificationService = require("../services/notificationService");

const calls = { push: [], create: [] };
let pushResult;
let createResult;
let createShouldThrow = false;

pushService.sendPushToUser = async (...args) => {
  calls.push.push(args);
  return pushResult;
};
notificationService.createAndSendNotification = async (...args) => {
  calls.create.push(args);
  if (createShouldThrow) throw new Error("notification db down");
  return createResult;
};

const UserSubscription = require("../models/UserSubscription");
const SubscriptionPlan = require("../models/SubscriptionPlan");
const TravelPlanAlertMatch = require("../models/travelPlanAlertMatchModel");
const Notification = require("../models/notificationModel");
const access = require("../services/subscriptionAccessService");
const stripeWebhookController = require("../controllers/stripeWebhookController");
const { resyncStaleSubscriptions } = require("../services/subscriptionResyncService");
const retry = require("../services/matchNotificationRetryService");

const DAY = 24 * 60 * 60 * 1000;
const MIN = 60 * 1000;
const NOW = new Date("2026-10-13T12:00:00Z");

const saved = {
  subFindOne: UserSubscription.findOne,
  subFindAll: UserSubscription.findAll,
  planFindOne: SubscriptionPlan.findOne,
  matchFindAll: TravelPlanAlertMatch.findAll,
  matchUpdate: TravelPlanAlertMatch.update,
  notifUpdate: Notification.update,
  sync: stripeWebhookController._private.syncSubscriptionFromStripe,
  consoleError: console.error,
};

let matchUpdates;
let notifUpdates;

test.beforeEach(() => {
  calls.push = [];
  calls.create = [];
  pushResult = { pushSuccess: true, reason: null };
  createResult = { success: true, pushSuccess: true, notificationId: 77 };
  createShouldThrow = false;
  matchUpdates = [];
  notifUpdates = [];
  delete process.env.SUBSCRIPTION_ACCESS_GRACE_DAYS;
  delete process.env.MATCH_NOTIFICATION_MAX_ATTEMPTS;
  delete process.env.MATCH_NOTIFICATION_RETRY_BASE_MS;
  console.error = () => {};

  TravelPlanAlertMatch.update = async (values, { where }) => {
    matchUpdates.push({ id: where.id, values });
    return [1];
  };
  Notification.update = async (values, { where }) => {
    notifUpdates.push({ id: where.id, values });
    return [1];
  };
});

test.afterEach(() => {
  UserSubscription.findOne = saved.subFindOne;
  UserSubscription.findAll = saved.subFindAll;
  SubscriptionPlan.findOne = saved.planFindOne;
  TravelPlanAlertMatch.findAll = saved.matchFindAll;
  TravelPlanAlertMatch.update = saved.matchUpdate;
  Notification.update = saved.notifUpdate;
  stripeWebhookController._private.syncSubscriptionFromStripe = saved.sync;
  console.error = saved.consoleError;
});

// ---------------------------------------------------------------- access

test("past_due keeps access, unpaid and canceled do not", () => {
  const future = new Date(NOW.getTime() + 10 * DAY);

  assert.equal(access.hasSubscriptionAccess({ status: "active", currentPeriodEnd: future }, NOW), true);
  assert.equal(access.hasSubscriptionAccess({ status: "trialing", currentPeriodEnd: future }, NOW), true);
  assert.equal(access.hasSubscriptionAccess({ status: "past_due", currentPeriodEnd: future }, NOW), true);
  assert.equal(access.hasSubscriptionAccess({ status: "unpaid", currentPeriodEnd: future }, NOW), false);
  assert.equal(access.hasSubscriptionAccess({ status: "canceled", currentPeriodEnd: future }, NOW), false);
  assert.equal(access.hasSubscriptionAccess({ status: "incomplete", currentPeriodEnd: future }, NOW), false);
  assert.equal(access.hasSubscriptionAccess(null, NOW), false);
});

test("an expired period only grants access inside the grace window", () => {
  const endedYesterday = new Date(NOW.getTime() - 1 * DAY);
  const endedLongAgo = new Date(NOW.getTime() - 5 * DAY);

  assert.equal(access.hasSubscriptionAccess({ status: "active", currentPeriodEnd: endedYesterday }, NOW), true);
  assert.equal(access.hasSubscriptionAccess({ status: "active", currentPeriodEnd: endedLongAgo }, NOW), false);

  process.env.SUBSCRIPTION_ACCESS_GRACE_DAYS = "0";
  assert.equal(access.hasSubscriptionAccess({ status: "active", currentPeriodEnd: endedYesterday }, NOW), false);
});

test("a missing period end does not block access", () => {
  assert.equal(access.hasSubscriptionAccess({ status: "active", currentPeriodEnd: null }, NOW), true);
});

test("access where-clause includes past_due and the period cutoff", () => {
  const where = access.buildAccessibleSubscriptionWhere(9, NOW);
  const statuses = Object.getOwnPropertySymbols(where.status).map((s) => where.status[s]);

  assert.equal(where.userId, 9);
  assert.deepEqual(statuses[0], ["active", "trialing", "past_due"]);
  assert.equal(access.getAccessCutoff(NOW).getTime(), NOW.getTime() - 2 * DAY);
});

// ----------------------------------------------------------------- resync

test("resync corrects stale subscriptions through the sync function", async () => {
  let findWhere;
  UserSubscription.findAll = async ({ where }) => {
    findWhere = where;
    return [
      { userId: 1, stripeSubscriptionId: "sub_ok" },
      { userId: 2, stripeSubscriptionId: "sub_bad" },
      { userId: 3, stripeSubscriptionId: "sub_ok2" },
    ];
  };

  const synced = [];
  stripeWebhookController._private.syncSubscriptionFromStripe = async (sub) => {
    synced.push(sub.id);
  };

  const stripe = {
    subscriptions: {
      retrieve: async (id) => {
        if (id === "sub_bad") throw new Error("stripe unavailable");
        return { id, status: "canceled" };
      },
    },
  };

  const summary = await resyncStaleSubscriptions({ now: NOW, stripe });

  assert.deepEqual(summary, { checked: 3, synced: 2, failed: 1 });
  assert.deepEqual(synced, ["sub_ok", "sub_ok2"]);

  // Canceled rows are final; only period-ended / never / long-unsynced rows qualify.
  const symbols = Object.getOwnPropertySymbols(findWhere);
  const orClauses = findWhere[symbols.find((s) => s.toString().includes("or"))];
  assert.equal(orClauses.length, 3);
  assert.ok(findWhere.status);
});

test("sync reads the period from items and maps unsupported statuses", async () => {
  const row = { id: 1, userId: 4, planId: 2, stripeCustomerId: "cus_1", save: async () => {} };
  UserSubscription.findOne = async () => row;
  SubscriptionPlan.findOne = async () => null;

  await stripeWebhookController._private.syncSubscriptionFromStripe({
    id: "sub_1",
    customer: "cus_1",
    status: "incomplete_expired",
    items: { data: [{ price: { id: "price_1" }, current_period_start: 1700000000, current_period_end: 1702592000 }] },
  });

  assert.equal(row.status, "canceled");
  assert.equal(row.currentPeriodEnd.getTime(), 1702592000 * 1000);
  assert.ok(row.lastSyncedAt instanceof Date);
});

// --------------------------------------------------------- payment failed

test("invoice subscription id is read from both Stripe shapes", () => {
  const { getInvoiceSubscriptionId } = stripeWebhookController._private;

  assert.equal(getInvoiceSubscriptionId({ subscription: "sub_old" }), "sub_old");
  assert.equal(
    getInvoiceSubscriptionId({ parent: { subscription_details: { subscription: "sub_new" } } }),
    "sub_new"
  );
  assert.equal(getInvoiceSubscriptionId({ subscription: { id: "sub_obj" } }), "sub_obj");
  assert.equal(getInvoiceSubscriptionId({}), null);
});

test("payment failure notifies the user and points at the billing portal", async () => {
  UserSubscription.findOne = async () => ({ userId: 3 });

  await stripeWebhookController._private.notifyPaymentFailed(
    { customer: "cus_1", billing_reason: "subscription_cycle", attempt_count: 2 },
    "sub_1"
  );

  assert.equal(calls.create.length, 1);
  const [userId, title, , data] = calls.create[0];
  assert.equal(userId, 3);
  assert.equal(title, "Payment failed");
  assert.equal(data.type, "payment_failed");
  assert.equal(data.action, "open_billing_portal");
  assert.equal(data.attemptCount, 2);
});

test("payment failure skips first payments and unknown users, and never throws", async () => {
  const { notifyPaymentFailed } = stripeWebhookController._private;

  UserSubscription.findOne = async () => ({ userId: 3 });
  await notifyPaymentFailed({ billing_reason: "subscription_create" }, "sub_1");
  assert.equal(calls.create.length, 0);

  UserSubscription.findOne = async () => null;
  await notifyPaymentFailed({ billing_reason: "subscription_cycle" }, "sub_1");
  assert.equal(calls.create.length, 0);

  UserSubscription.findOne = async () => ({ userId: 3 });
  createShouldThrow = true;
  await assert.doesNotReject(() =>
    notifyPaymentFailed({ billing_reason: "subscription_cycle" }, "sub_1")
  );
});

// ------------------------------------------------------------ match retry

const pendingMatch = (overrides = {}) => ({
  id: 10,
  clientId: 5,
  tradesmanId: 6,
  travelPlanId: 7,
  clientTradeAlertId: 8,
  matchedStopName: "Perth",
  estimatedArrivalDate: null,
  status: "pending",
  notificationAttempts: 1,
  lastNotificationAttemptAt: new Date(NOW.getTime() - 10 * MIN),
  notificationId: 55,
  ...overrides,
});

test("retry delay grows with each attempt", () => {
  assert.equal(retry.getRetryDelayMs(1), 5 * MIN);
  assert.equal(retry.getRetryDelayMs(2), 10 * MIN);
  assert.equal(retry.getRetryDelayMs(3), 20 * MIN);
});

test("a due pending match is retried with the stored notification and marked notified", async () => {
  TravelPlanAlertMatch.findAll = async () => [pendingMatch()];

  const summary = await retry.retryPendingMatchNotifications({ now: NOW });

  assert.deepEqual(summary, { checked: 1, delivered: 1, retryLater: 0, failed: 0 });
  assert.equal(calls.push.length, 1);
  assert.equal(calls.create.length, 0, "must not create a second inbox notification");
  assert.equal(calls.push[0][3].notificationId, 55);
  assert.equal(notifUpdates[0].values.deliveryStatus, "sent");
  assert.equal(matchUpdates[0].values.status, "notified");
  assert.equal(matchUpdates[0].values.notificationSent, true);
  assert.equal(matchUpdates[0].values.notificationAttempts, 2);
});

test("a match whose backoff has not elapsed is left alone", async () => {
  TravelPlanAlertMatch.findAll = async () => [
    pendingMatch({ lastNotificationAttemptAt: new Date(NOW.getTime() - 1 * MIN) }),
  ];

  const summary = await retry.retryPendingMatchNotifications({ now: NOW });

  assert.equal(summary.checked, 0);
  assert.equal(calls.push.length, 0);
  assert.equal(matchUpdates.length, 0);
});

test("a failed retry below the limit stays pending for the next pass", async () => {
  pushResult = { pushSuccess: false, reason: "NO_TOKENS" };
  TravelPlanAlertMatch.findAll = async () => [pendingMatch({ notificationAttempts: 2 })];

  const summary = await retry.retryPendingMatchNotifications({ now: NOW });

  assert.equal(summary.retryLater, 1);
  assert.equal(matchUpdates[0].values.status, undefined);
  assert.equal(matchUpdates[0].values.notificationAttempts, 3);
  assert.equal(matchUpdates[0].values.notificationError, "NO_TOKENS");
  assert.equal(notifUpdates[0].values.deliveryStatus, "skipped");
});

test("a match is marked failed when the attempt limit is reached", async () => {
  pushResult = { pushSuccess: false, reason: "ALL_PUSHES_FAILED" };
  TravelPlanAlertMatch.findAll = async () => [
    pendingMatch({ notificationAttempts: 4, lastNotificationAttemptAt: new Date(NOW.getTime() - 2 * 60 * MIN) }),
  ];

  const summary = await retry.retryPendingMatchNotifications({ now: NOW });

  assert.equal(summary.failed, 1);
  assert.equal(matchUpdates[0].values.status, "failed");
  assert.equal(matchUpdates[0].values.notificationAttempts, 5);
});

test("when the inbox row was never stored the retry creates it once and keeps its id", async () => {
  TravelPlanAlertMatch.findAll = async () => [pendingMatch({ notificationId: null })];

  await retry.retryPendingMatchNotifications({ now: NOW });

  assert.equal(calls.create.length, 1);
  assert.equal(calls.push.length, 0);
  assert.equal(matchUpdates[0].values.notificationId, 77);
  assert.equal(matchUpdates[0].values.status, "notified");
});

test("an exception while sending counts as a failed attempt and never throws", async () => {
  TravelPlanAlertMatch.findAll = async () => [pendingMatch({ notificationId: null })];
  createShouldThrow = true;

  const summary = await retry.retryPendingMatchNotifications({ now: NOW });

  assert.equal(summary.retryLater, 1);
  assert.equal(matchUpdates[0].values.notificationAttempts, 2);
  assert.match(matchUpdates[0].values.notificationError, /notification db down/);
});
