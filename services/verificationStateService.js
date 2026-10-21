const sequelize = require("../config/db");
const TradesType = require("../models/tradesTypeModel");

/**
 * The single place that changes a tradesman's verification state.
 *
 * Four stored values describe it and must never drift apart:
 *   TradesmanDetails.isApproved, .verificationStatus, .licenceVerified   and   Users.isVerified
 * (Users.isVerified feeds dashboard counts and report filters.) Every path that approves, rejects, resets or
 * resubmits someone (register, profile update, admin approve/reject, subscription auto-approval, bulk
 * changes, test users, migrations' backfill logic) calls applyVerificationState instead of setting them by hand.
 *
 *   pending      new, or reset (for example after switching to a licence-required trade)
 *   resubmitted  a rejected tradesman sent their profile again (keeps the old rejection reason for the admin)
 *   approved     listed. `licenceVerified` says whether a licence was checked (licence-required trades only)
 *   rejected     waiting for the tradesman to fix something; `reason` is shown to them
 */
const STATES = ["pending", "resubmitted", "approved", "rejected"];

/**
 * Pure: the column values for a state, for the details row and the user row.
 *
 * @param {"pending"|"resubmitted"|"approved"|"rejected"} state
 * @param {{ adminId?: number|null, reason?: string|null, licenceVerified?: boolean, now?: Date }} [options]
 *   adminId: who decided (null for automatic approval); reason: required for "rejected";
 *   licenceVerified: only honoured for "approved".
 */
const buildStatePatch = (state, { adminId = null, reason = null, licenceVerified = false, now = new Date() } = {}) => {
  if (!STATES.includes(state)) throw new Error(`Unknown verification state: ${state}`);

  switch (state) {
    case "approved":
      return {
        details: {
          isApproved: true,
          verificationStatus: "approved",
          licenceVerified: Boolean(licenceVerified),
          approvedBy: adminId,
          approvedAt: now,
          rejectionReason: null,
        },
        user: { isVerified: true },
      };
    case "rejected":
      if (!reason) throw new Error("A rejection reason is required");
      return {
        details: {
          isApproved: false,
          verificationStatus: "rejected",
          licenceVerified: false,
          approvedBy: adminId,
          approvedAt: now,
          rejectionReason: reason,
        },
        user: { isVerified: false },
      };
    case "resubmitted":
      return {
        details: {
          isApproved: false,
          verificationStatus: "resubmitted",
          licenceVerified: false,
          resubmittedAt: now,
          // rejectionReason is kept on purpose: the admin sees what was flagged before.
        },
        user: { isVerified: false },
      };
    default: // "pending"
      return {
        details: {
          isApproved: false,
          verificationStatus: "pending",
          licenceVerified: false,
          rejectionReason: null,
        },
        user: { isVerified: false },
      };
  }
};

/**
 * Applies a state to a TradesmanDetails row and its User row and saves both, inside `transaction` when given.
 * Returns { details, user } (the same instances, updated).
 */
const applyVerificationState = async (details, user, state, options = {}) => {
  const patch = buildStatePatch(state, options);
  const saveOptions = options.transaction ? { transaction: options.transaction } : {};

  await details.update(patch.details, saveOptions);
  await user.update(patch.user, saveOptions);
  return { details, user };
};

/**
 * SQL condition for queries on TradesmanDetails: "this tradesperson's trade needs a licence". Only those people
 * ever need an admin to look at them, so the review queue and its badge use it.
 */
const buildLicenceRequiredLiteral = (detailsAlias = "`TradesmanDetails`") =>
  sequelize.literal(
    `EXISTS (SELECT 1 FROM \`trades_type\` AS \`lt\` WHERE \`lt\`.\`id\` = ${detailsAlias}.\`tradeTypeId\` AND \`lt\`.\`licenceRequired\` = 1)`,
  );

/** Does this trade need a licence? Missing or unknown trades count as "no" (the server decides, never the app). */
const isLicenceRequired = async (tradeTypeId, { transaction } = {}) => {
  if (!tradeTypeId) return false;
  const trade = await TradesType.findByPk(tradeTypeId, { attributes: ["licenceRequired"], transaction });
  return Boolean(trade && trade.licenceRequired);
};

/* ---------------- licence expiry ---------------- */

const BRISBANE_TIME_ZONE = "Australia/Brisbane";
const DAY_MS = 24 * 60 * 60 * 1000;

/** Today's calendar date in Queensland as "YYYY-MM-DD". Queensland has no daylight saving. */
const brisbaneDateKey = (now = new Date()) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: BRISBANE_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);

const toDayNumber = (dateKey) => {
  const [year, month, day] = dateKey.split("-").map(Number);
  return Date.UTC(year, month - 1, day) / DAY_MS;
};

/**
 * Where a licence expiry stands today, for badges and warnings.
 * The expiry is a calendar date (the day printed on the licence); it is valid through the end of that
 * day in Queensland. Returns { known, expired, daysLeft } (daysLeft: 0 = expires today, negative = expired).
 */
const licenceExpiryStatus = (licenceExpiry, now = new Date()) => {
  const expiry = licenceExpiry ? new Date(licenceExpiry) : null;
  if (!expiry || Number.isNaN(expiry.getTime())) return { known: false, expired: false, daysLeft: null };

  const daysLeft = toDayNumber(expiry.toISOString().slice(0, 10)) - toDayNumber(brisbaneDateKey(now));
  return { known: true, expired: daysLeft < 0, daysLeft };
};

module.exports = {
  STATES,
  buildStatePatch,
  applyVerificationState,
  isLicenceRequired,
  buildLicenceRequiredLiteral,
  brisbaneDateKey,
  licenceExpiryStatus,
};
