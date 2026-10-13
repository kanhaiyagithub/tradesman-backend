const Stripe = require("stripe");
const { Op } = require("sequelize");

const UserSubscription = require("../models/UserSubscription");
const stripeWebhookController = require("../controllers/stripeWebhookController");
const { withJobLock } = require("./backgroundJobLockService");
const { getNextDailyRunDate } = require("./emailReminderService");

/**
 * Daily safety net for missed Stripe webhooks.
 *
 * Webhooks stay the main source of truth. This job re-fetches the real status
 * from Stripe for subscriptions that look wrong or have not been confirmed
 * recently, and corrects the database with the same sync function the webhook
 * uses. Request-time access checks never call Stripe.
 */

const SUBSCRIPTION_RESYNC_LOCK = "tradesman:subscription-resync";
const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_STALE_HOURS = 72;
const DEFAULT_BATCH_SIZE = 200;

let stripeClient = null;

const getStripe = () => {
  if (!stripeClient) stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY);
  return stripeClient;
};

const getNumberEnv = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

/**
 * Re-syncs subscriptions whose period has ended or that were not confirmed with
 * Stripe recently. Canceled subscriptions are final and skipped.
 *
 * @param {object} [options]
 * @param {Date} [options.now]
 * @param {{ subscriptions: { retrieve: Function } }} [options.stripe] - Stripe client (tests).
 * @returns {Promise<{checked: number, synced: number, failed: number}>}
 */
const resyncStaleSubscriptions = async ({ now = new Date(), stripe = null } = {}) => {
  const summary = { checked: 0, synced: 0, failed: 0 };
  const staleCutoff = new Date(
    now.getTime() - getNumberEnv("SUBSCRIPTION_RESYNC_STALE_HOURS", DEFAULT_STALE_HOURS) * HOUR_MS
  );

  const rows = await UserSubscription.findAll({
    where: {
      stripeSubscriptionId: { [Op.ne]: null },
      status: { [Op.ne]: "canceled" },
      [Op.or]: [
        { currentPeriodEnd: { [Op.lt]: now } },
        { lastSyncedAt: null },
        { lastSyncedAt: { [Op.lt]: staleCutoff } },
      ],
    },
    order: [["lastSyncedAt", "ASC"]],
    limit: getNumberEnv("SUBSCRIPTION_RESYNC_BATCH_SIZE", DEFAULT_BATCH_SIZE),
  });

  const client = stripe || getStripe();

  for (const row of rows) {
    summary.checked += 1;

    try {
      const stripeSubscription = await client.subscriptions.retrieve(row.stripeSubscriptionId);
      await stripeWebhookController._private.syncSubscriptionFromStripe(stripeSubscription);
      summary.synced += 1;
    } catch (error) {
      summary.failed += 1;
      console.error("[SUBSCRIPTION_RESYNC] Failed to re-sync subscription", {
        userId: row.userId,
        stripeSubscriptionId: row.stripeSubscriptionId,
        error: error.message,
      });
    }
  }

  return summary;
};

/** Lock-guarded run; safe if several API/worker instances are running. */
const runSubscriptionResync = async (options = {}) => {
  const lockResult = await withJobLock(SUBSCRIPTION_RESYNC_LOCK, () =>
    resyncStaleSubscriptions(options)
  );

  if (lockResult.skipped) {
    console.log("[SUBSCRIPTION_RESYNC] Skipped", { reason: lockResult.reason });
    return lockResult;
  }

  console.log("[SUBSCRIPTION_RESYNC] Completed", lockResult.result);
  return lockResult.result;
};

const getScheduleConfig = () => {
  const hour = Number(process.env.SUBSCRIPTION_RESYNC_RUN_HOUR ?? 3);
  const minute = Number(process.env.SUBSCRIPTION_RESYNC_RUN_MINUTE ?? 0);

  return {
    hour: Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 3,
    minute: Number.isInteger(minute) && minute >= 0 && minute <= 59 ? minute : 0,
    runOnStart: String(process.env.SUBSCRIPTION_RESYNC_RUN_ON_START || "false").toLowerCase() === "true",
  };
};

/** Starts the daily re-sync (server local time). Returns { stop }. */
const startSubscriptionResyncJob = () => {
  const schedule = getScheduleConfig();
  let timer = null;
  let stopped = false;

  const safeRun = async () => {
    try {
      await runSubscriptionResync();
    } catch (error) {
      console.error("[SUBSCRIPTION_RESYNC] Job failed", error.message);
    }
  };

  const scheduleNext = () => {
    if (stopped) return;

    const now = new Date();
    const nextRun = getNextDailyRunDate(now, schedule);

    timer = setTimeout(async () => {
      await safeRun();
      scheduleNext();
    }, nextRun.getTime() - now.getTime());

    if (typeof timer.unref === "function") timer.unref();
  };

  if (schedule.runOnStart) safeRun();
  scheduleNext();

  console.log("[SUBSCRIPTION_RESYNC] Daily job started", {
    runHour: schedule.hour,
    runMinute: schedule.minute,
    runOnStart: schedule.runOnStart,
  });

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
};

module.exports = {
  resyncStaleSubscriptions,
  runSubscriptionResync,
  startSubscriptionResyncJob,
};
