const { refreshTravelPlanStatuses } = require("./travelPlanStatusService");
const { startNotificationCleanupJob } = require("./notificationCleanupService");
const { startMessageCleanupJob } = require("./messageCleanupService");
const { startMatchReminderEmailJob } = require("./emailReminderService");
const { startSubscriptionResyncJob } = require("./subscriptionResyncService");
const { startMatchNotificationRetryJob } = require("./matchNotificationRetryService");

const DEFAULT_STATUS_REFRESH_INTERVAL_MS = 60 * 1000;

function shouldStartBackgroundJobsInApiProcess() {
  const value = String(process.env.ENABLE_API_BACKGROUND_JOBS || "").toLowerCase();

  if (["true", "1", "yes"].includes(value)) {
    return true;
  }

  if (["false", "0", "no"].includes(value)) {
    return false;
  }

  return process.env.NODE_ENV !== "production";
}

async function refreshTravelPlanStatusesSafely() {
  try {
    await refreshTravelPlanStatuses();
  } catch (error) {
    console.error("[TRAVEL_PLAN_STATUS_REFRESH_ERROR]", error);
  }
}

function startBackgroundJobs() {
  const timers = [];
  const workers = [];
  const statusRefreshIntervalMs = Number(
    process.env.TRAVEL_PLAN_STATUS_REFRESH_INTERVAL_MS ||
      DEFAULT_STATUS_REFRESH_INTERVAL_MS
  );

  refreshTravelPlanStatusesSafely();
  workers.push(startNotificationCleanupJob());
  workers.push(startMessageCleanupJob());
  workers.push(startMatchReminderEmailJob());
  workers.push(startSubscriptionResyncJob());
  workers.push(startMatchNotificationRetryJob());

  const statusRefreshTimer = setInterval(
    refreshTravelPlanStatusesSafely,
    statusRefreshIntervalMs
  );

  if (typeof statusRefreshTimer.unref === "function") {
    statusRefreshTimer.unref();
  }

  timers.push(statusRefreshTimer);

  return {
    stop: () => {
      for (const timer of timers) {
        clearInterval(timer);
      }

      for (const worker of workers) {
        if (worker && typeof worker.stop === "function") {
          worker.stop();
        } else if (worker) {
          clearInterval(worker);
          clearTimeout(worker);
        }
      }
    },
  };
}

module.exports = {
  refreshTravelPlanStatusesSafely,
  shouldStartBackgroundJobsInApiProcess,
  startBackgroundJobs,
};
