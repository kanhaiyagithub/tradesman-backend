const http = require('http');
const dotenv = require('dotenv');

// dotenv.config({ path: './config/config.env' });
dotenv.config();

const app = require('./app');
const socket = require('./socket');
const { refreshTravelPlanStatuses } = require('./services/travelPlanStatusService');

const server = http.createServer(app);
socket.init(server);

const PORT = process.env.PORT || 5000;
const TRAVEL_PLAN_STATUS_REFRESH_INTERVAL_MS = Number(
  process.env.TRAVEL_PLAN_STATUS_REFRESH_INTERVAL_MS || 60 * 1000,
);

/**
 * Keeps travel-plan enum statuses aligned with their start/destination times.
 *
 * This is intentionally lightweight and safe to run repeatedly. Endpoint-level
 * checks also refresh statuses before enforcing the single-plan constraint.
 *
 * @returns {Promise<void>} Resolves after stale statuses are refreshed.
 */
async function refreshTravelPlanStatusesSafely() {
  try {
    await refreshTravelPlanStatuses();
  } catch (error) {
    console.error('[TRAVEL_PLAN_STATUS_REFRESH_ERROR]', error);
  }
}

server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);

  refreshTravelPlanStatusesSafely();

  const statusRefreshTimer = setInterval(
    refreshTravelPlanStatusesSafely,
    TRAVEL_PLAN_STATUS_REFRESH_INTERVAL_MS,
  );

  if (typeof statusRefreshTimer.unref === 'function') {
    statusRefreshTimer.unref();
  }
});
