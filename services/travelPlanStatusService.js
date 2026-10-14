const { Op } = require("sequelize");
const TravelPlan = require("../models/locationModel");
const { withJobLock } = require("./backgroundJobLockService");

const TRAVEL_PLAN_STATUSES = ["open", "running", "closed"];
const ACTIVE_TRAVEL_PLAN_STATUSES = ["open", "running"];
const TRAVEL_PLAN_STATUS_LOCK = "tradesman:travel-plan-status-refresh";

/**
 * Derives the persisted status for a travel plan from its travel window.
 *
 * @param {Date|string} startDateTime - Planned start date/time.
 * @param {Date|string} destinationDateTime - Planned destination date/time.
 * @param {Date} [now=new Date()] - Clock value used for deterministic checks.
 * @returns {"open"|"running"|"closed"} Status matching the travel window.
 */
function getStatusForTravelWindow(startDateTime, destinationDateTime, now = new Date()) {
  const start = new Date(startDateTime);
  const destination = new Date(destinationDateTime);

  if (destination < now) {
    return "closed";
  }

  if (start <= now && destination >= now) {
    return "running";
  }

  return "open";
}

/**
 * Updates stale persisted travel-plan statuses before active-plan queries run.
 *
 * Expired open/running plans are closed, and open plans whose start time has
 * arrived are marked as running. This keeps enum status aligned with time.
 *
 * @param {object} [options] - Status refresh options.
 * @param {number|string} [options.tradesmanId] - Optional tradesman scope.
 * @param {Date} [options.now=new Date()] - Clock value for comparisons.
 * @returns {Promise<void>}
 */
async function refreshTravelPlanStatuses({ tradesmanId, now = new Date() } = {}) {
  const scopedWhere = tradesmanId ? { tradesmanId } : {};

  const refresh = async () => {
    await TravelPlan.update(
      { status: "closed" },
      {
        where: {
          ...scopedWhere,
          status: { [Op.in]: ACTIVE_TRAVEL_PLAN_STATUSES },
          destinationDateTime: { [Op.lt]: now },
        },
      },
    );

    await TravelPlan.update(
      { status: "running" },
      {
        where: {
          ...scopedWhere,
          status: "open",
          startDateTime: { [Op.lte]: now },
          destinationDateTime: { [Op.gte]: now },
        },
      },
    );
  };

  if (tradesmanId) {
    await refresh();
    return { skipped: false };
  }

  return withJobLock(TRAVEL_PLAN_STATUS_LOCK, refresh);
}

/**
 * Builds a Sequelize where-clause for plans that should block another plan.
 *
 * @param {number|string} tradesmanId - Tradesman/user id.
 * @param {Date} [now=new Date()] - Clock value for comparisons.
 * @returns {object} Sequelize where-clause for active or upcoming plans.
 */
function buildActiveOrUpcomingPlanWhere(tradesmanId, now = new Date()) {
  return {
    tradesmanId,
    status: { [Op.in]: ACTIVE_TRAVEL_PLAN_STATUSES },
    destinationDateTime: { [Op.gte]: now },
  };
}

/**
 * Where-clause for a plan that is under way right now (not merely upcoming).
 * Call refreshTravelPlanStatuses first so "running" reflects the clock.
 */
function buildRunningPlanWhere(tradesmanId, now = new Date()) {
  return {
    tradesmanId,
    status: "running",
    destinationDateTime: { [Op.gte]: now },
  };
}

module.exports = {
  ACTIVE_TRAVEL_PLAN_STATUSES,
  buildRunningPlanWhere,
  TRAVEL_PLAN_STATUSES,
  buildActiveOrUpcomingPlanWhere,
  getStatusForTravelWindow,
  refreshTravelPlanStatuses,
};
