const { Op } = require("sequelize");

const TravelPlanAlertMatch = require("../models/travelPlanAlertMatchModel");
const Notification = require("../models/notificationModel");
const { createAndSendNotification } = require("./notificationService");
const { sendPushToUser } = require("./pushNotificationService");
const { withJobLock } = require("./backgroundJobLockService");

/**
 * Retries the push for travel matches whose first delivery did not reach a
 * device. The match row is saved BEFORE the push is sent, and the in-app
 * notification row is stored first by createAndSendNotification, so the inbox
 * entry stays the guaranteed fallback. This job only retries the push.
 *
 * Every few minutes it picks up matches that are still `pending`, younger than
 * 24 hours and below the attempt limit, retries with growing delays
 * (base * 2^(attempts - 1)) and marks the match `failed` at the limit.
 */

const MATCH_NOTIFICATION_RETRY_LOCK = "tradesman:match-notification-retry";
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BASE_DELAY_MS = 5 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const WINDOW_MS = 24 * 60 * 60 * 1000;
const BATCH_SIZE = 100;

const getNumberEnv = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const getMaxAttempts = () => Math.floor(getNumberEnv("MATCH_NOTIFICATION_MAX_ATTEMPTS", DEFAULT_MAX_ATTEMPTS));

/** Same title/body/data as the first send in travelAlertService.createMatchAndNotify. */
const buildMatchPushPayload = (match) => ({
  title: "Tradesman available near you",
  body: `A tradesman is expected near ${match.matchedStopName}. Tap to view details.`,
  data: {
    type: "travel_match",
    matchId: match.id,
    travelPlanId: match.travelPlanId,
    tradesmanId: match.tradesmanId,
    clientTradeAlertId: match.clientTradeAlertId,
    matchedStopName: match.matchedStopName,
    estimatedArrivalDate: match.estimatedArrivalDate || "",
  },
});

/** Delay before retry number `attempts + 1`: base, 2x base, 4x base... */
const getRetryDelayMs = (attempts) =>
  getNumberEnv("MATCH_NOTIFICATION_RETRY_BASE_MS", DEFAULT_BASE_DELAY_MS) *
  2 ** Math.max(Number(attempts) - 1, 0);

const isRetryDue = (match, now) => {
  if (!match.lastNotificationAttemptAt) return true;

  return (
    new Date(match.lastNotificationAttemptAt).getTime() +
      getRetryDelayMs(match.notificationAttempts) <=
    now.getTime()
  );
};

/** Sends the push once; reuses the stored inbox row when there is one. */
const deliverMatchPush = async (match) => {
  const { title, body, data } = buildMatchPushPayload(match);

  if (match.notificationId) {
    const push = await sendPushToUser(match.clientId, title, body, {
      ...data,
      notificationId: match.notificationId,
    });

    const deliveryStatus = push.pushSuccess
      ? "sent"
      : push.reason === "NO_TOKENS" || push.reason === "NO_VALID_TOKENS"
        ? "skipped"
        : "failed";

    await Notification.update(
      {
        deliveryStatus,
        deliveryError: push.pushSuccess ? null : String(push.reason || "PUSH_FAILED").slice(0, 255),
        sentAt: push.pushSuccess ? new Date() : null,
      },
      { where: { id: match.notificationId } }
    );

    return { pushSuccess: push.pushSuccess, reason: push.reason, notificationId: match.notificationId };
  }

  // The inbox row was never stored (e.g. a database error); create it now.
  const result = await createAndSendNotification(match.clientId, title, body, data);
  return {
    pushSuccess: Boolean(result.pushSuccess),
    reason: result.pushReason || result.reason,
    notificationId: result.notificationId,
  };
};

const retryOneMatch = async (match, now) => {
  const attempts = (Number(match.notificationAttempts) || 0) + 1;
  const update = { notificationAttempts: attempts, lastNotificationAttemptAt: now };
  let delivered = false;

  try {
    const outcome = await deliverMatchPush(match);
    if (outcome.notificationId) update.notificationId = outcome.notificationId;

    if (outcome.pushSuccess) {
      delivered = true;
      Object.assign(update, {
        status: "notified",
        notificationSent: true,
        notificationSentAt: now,
        notificationError: null,
      });
    } else {
      update.notificationError = String(outcome.reason || "PUSH_FAILED").slice(0, 255);
    }
  } catch (error) {
    update.notificationError = String(error.message || "PUSH_FAILED").slice(0, 255);
  }

  if (!delivered && attempts >= getMaxAttempts()) {
    update.status = "failed";
  }

  await TravelPlanAlertMatch.update(update, { where: { id: match.id, status: "pending" } });
  return { delivered, failedPermanently: update.status === "failed" };
};

/**
 * One pass of the retry job.
 *
 * @param {object} [options]
 * @param {Date} [options.now]
 * @returns {Promise<{checked: number, delivered: number, retryLater: number, failed: number}>}
 */
const retryPendingMatchNotifications = async ({ now = new Date() } = {}) => {
  const summary = { checked: 0, delivered: 0, retryLater: 0, failed: 0 };

  const matches = await TravelPlanAlertMatch.findAll({
    where: {
      status: "pending",
      createdAt: { [Op.gt]: new Date(now.getTime() - WINDOW_MS) },
      notificationAttempts: { [Op.lt]: getMaxAttempts() },
    },
    order: [["createdAt", "ASC"]],
    limit: BATCH_SIZE,
  });

  for (const match of matches) {
    if (!isRetryDue(match, now)) continue;

    summary.checked += 1;

    try {
      const outcome = await retryOneMatch(match, now);
      if (outcome.delivered) summary.delivered += 1;
      else if (outcome.failedPermanently) summary.failed += 1;
      else summary.retryLater += 1;
    } catch (error) {
      summary.retryLater += 1;
      console.error("[MATCH_NOTIFICATION_RETRY] Retry failed", {
        matchId: match.id,
        error: error.message,
      });
    }
  }

  return summary;
};

const runMatchNotificationRetry = async (options = {}) => {
  const lockResult = await withJobLock(MATCH_NOTIFICATION_RETRY_LOCK, () =>
    retryPendingMatchNotifications(options)
  );

  if (lockResult.skipped) return lockResult;

  if (lockResult.result.checked > 0) {
    console.log("[MATCH_NOTIFICATION_RETRY] Completed", lockResult.result);
  }

  return lockResult.result;
};

/** Starts the every-few-minutes retry loop. Returns { stop }. */
const startMatchNotificationRetryJob = () => {
  const intervalMs = getNumberEnv("MATCH_NOTIFICATION_RETRY_INTERVAL_MS", DEFAULT_INTERVAL_MS);

  const safeRun = async () => {
    try {
      await runMatchNotificationRetry();
    } catch (error) {
      console.error("[MATCH_NOTIFICATION_RETRY] Job failed", error.message);
    }
  };

  const timer = setInterval(safeRun, intervalMs);
  if (typeof timer.unref === "function") timer.unref();

  return { stop: () => clearInterval(timer) };
};

module.exports = {
  buildMatchPushPayload,
  getRetryDelayMs,
  retryPendingMatchNotifications,
  runMatchNotificationRetry,
  startMatchNotificationRetryJob,
};
