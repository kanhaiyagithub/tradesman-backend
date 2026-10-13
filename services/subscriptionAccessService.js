const { Op } = require("sequelize");

/**
 * Local-database subscription access rules (no Stripe call per request).
 *
 * Stripe webhooks plus the daily re-sync keep `status` and `currentPeriodEnd`
 * correct; access checks only read those columns.
 *
 * - `past_due` keeps access while Stripe retries a failed card.
 * - Access is cut at `unpaid` / `canceled` (or any non-listed status).
 * - `currentPeriodEnd` must still be in the future, allowing a small grace
 *   window in case a renewal webhook is late. A null period end is allowed
 *   because it only means the row has not been synced with period data yet.
 */
const ACCESS_STATUSES = ["active", "trialing", "past_due"];
const DEFAULT_GRACE_DAYS = 2;
const DAY_MS = 24 * 60 * 60 * 1000;

const getGraceDays = () => {
  const raw = process.env.SUBSCRIPTION_ACCESS_GRACE_DAYS;
  if (raw === undefined || raw === "") return DEFAULT_GRACE_DAYS;

  const days = Number(raw);
  return Number.isFinite(days) && days >= 0 ? days : DEFAULT_GRACE_DAYS;
};

/** Earliest `currentPeriodEnd` that still grants access at `now`. */
const getAccessCutoff = (now = new Date()) =>
  new Date(now.getTime() - getGraceDays() * DAY_MS);

/**
 * Sequelize where-clause for "this user currently has access".
 *
 * @param {number} userId
 * @param {Date} [now]
 */
const buildAccessibleSubscriptionWhere = (userId, now = new Date()) => ({
  userId,
  status: { [Op.in]: ACCESS_STATUSES },
  [Op.or]: [
    { currentPeriodEnd: null },
    { currentPeriodEnd: { [Op.gt]: getAccessCutoff(now) } },
  ],
});

/** In-memory version of the same rule for an already-loaded row. */
const hasSubscriptionAccess = (subscription, now = new Date()) => {
  if (!subscription || !ACCESS_STATUSES.includes(subscription.status)) return false;
  if (!subscription.currentPeriodEnd) return true;

  return new Date(subscription.currentPeriodEnd).getTime() > getAccessCutoff(now).getTime();
};

module.exports = {
  ACCESS_STATUSES,
  buildAccessibleSubscriptionWhere,
  hasSubscriptionAccess,
  getAccessCutoff,
  getGraceDays,
};
