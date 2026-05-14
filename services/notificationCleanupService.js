const { deleteExpiredNotifications } = require("./notificationService");

const DEFAULT_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Deletes expired notifications and logs the result without crashing the app.
 *
 * @returns {Promise<void>} Resolves after cleanup attempt finishes.
 */
const deleteExpiredNotificationsSafely = async () => {
  try {
    const deletedCount = await deleteExpiredNotifications();

    if (deletedCount > 0) {
      console.log("[NOTIFICATION CLEANUP] Deleted expired notifications", {
        deletedCount,
        at: new Date().toISOString(),
      });
    }
  } catch (error) {
    console.error("[NOTIFICATION CLEANUP ERROR]", {
      message: error.message,
      stack: error.stack,
    });
  }
};

/**
 * Starts the lightweight notification cleanup loop.
 *
 * The deletion query is idempotent, so it is safe even if more than one API
 * instance runs it. For larger production deployments, prefer a dedicated
 * worker, DB event, or platform scheduler that calls the same cleanup logic.
 *
 * @returns {NodeJS.Timeout} Cleanup timer.
 */
const startNotificationCleanupJob = () => {
  const cleanupIntervalMs = Number(
    process.env.NOTIFICATION_CLEANUP_INTERVAL_MS || DEFAULT_CLEANUP_INTERVAL_MS,
  );

  deleteExpiredNotificationsSafely();

  const cleanupTimer = setInterval(deleteExpiredNotificationsSafely, cleanupIntervalMs);

  if (typeof cleanupTimer.unref === "function") {
    cleanupTimer.unref();
  }

  return cleanupTimer;
};

module.exports = {
  deleteExpiredNotificationsSafely,
  startNotificationCleanupJob,
};
