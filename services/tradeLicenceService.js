const { Op } = require("sequelize");
const User = require("../models/User");
const TradesmanDetails = require("../models/TradesmanDetails");
const UserSubscription = require("../models/UserSubscription");
const { buildAccessibleSubscriptionWhere } = require("./subscriptionAccessService");
const { applyVerificationState, isLicenceRequired } = require("./verificationStateService");
const { validateApprovalReadiness } = require("./approvalReadiness");

/**
 * Licence rules that depend on a trade's `licenceRequired` flag:
 *  - counting who a change would affect,
 *  - asking already-listed tradespeople for a licence when a trade becomes licence-required,
 *  - approving waiting tradespeople automatically when a trade is NOT licence-required.
 * Test (dummy) users are never counted or changed here.
 */

const MAX_LABEL_LENGTH = 120;

/** Cleans admin-typed text that is shown in the app: tags, control characters and extra spaces go. */
const sanitizeLabel = (value) => {
  if (value === undefined || value === null) return null;
  const cleaned = String(value)
    .replace(/<[^>]*>/g, "")
    .replace(/[\t\r\n\f\v]/g, " ") // line breaks and tabs separate words; other control characters just go
    .split("")
    .filter((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || null;
};

const hasLicenceDetails = (details) =>
  Boolean(String(details.licenseNumber || "").trim()) &&
  Boolean(String(details.licenseDocument || "").trim()) &&
  Boolean(details.licenseExpiry);

const realTradesmen = (extraWhere) => ({
  model: User,
  as: "user",
  attributes: ["id", "name", "email", "isDummy"],
  where: { isDummy: false },
  required: true,
  ...extraWhere,
});

/** Listed (approved) tradespeople of a trade who have no verified licence: the ones a new requirement affects. */
const findListedWithoutVerifiedLicence = (tradeId, options = {}) =>
  TradesmanDetails.findAll({
    where: { tradeTypeId: tradeId, isApproved: true, licenceVerified: false },
    include: [realTradesmen()],
    ...options,
  });

const hasAccessibleSubscription = async (userId, options = {}) =>
  (await UserSubscription.count({ where: buildAccessibleSubscriptionWhere(userId), ...options })) > 0;

/** Waiting (pending or resubmitted) tradespeople of a trade who are paying members. */
const findWaitingSubscribed = async (tradeId, options = {}) => {
  const waiting = await TradesmanDetails.findAll({
    where: { tradeTypeId: tradeId, isApproved: false, verificationStatus: { [Op.in]: ["pending", "resubmitted"] } },
    include: [realTradesmen()],
    ...options,
  });
  const result = [];
  for (const details of waiting) {
    if (await hasAccessibleSubscription(details.userId, options)) result.push(details);
  }
  return result;
};

/**
 * What switching a trade's licence requirement would do, for the confirmation dialog.
 *  listedWithoutVerifiedLicence  would lose the "licence verified" badge when the requirement is turned ON
 *    completeLicence / missingLicence   of those, who already gave full licence details (-> pending) and who did not (-> rejected)
 *  waitingForReview  paying members waiting for review, who would be approved at once if it is turned OFF
 */
const countLicenceImpact = async (tradeId) => {
  const listed = await findListedWithoutVerifiedLicence(tradeId);
  const complete = listed.filter(hasLicenceDetails).length;
  const waiting = await findWaitingSubscribed(tradeId);

  return {
    listedWithoutVerifiedLicence: listed.length,
    completeLicence: complete,
    missingLicence: listed.length - complete,
    waitingForReview: waiting.length,
  };
};

/**
 * Turning a trade to licence-required, with "also ask them now": every listed tradesperson without a verified
 * licence stops being listed until an admin approves a licence. Full licence details -> back in the review queue
 * (pending); otherwise rejected with a reason telling them what to do. Runs inside `transaction`; the caller sends
 * the notifications after commit using the returned list. Returns { pending, rejected, notify: [{userId, state, reason}] }.
 */
const askListedForLicence = async (trade, { adminId, transaction }) => {
  const listed = await findListedWithoutVerifiedLicence(trade.id, { transaction });
  const reason = `A licence is now required for ${trade.name}. Please add your licence details so you can appear in search again.`;
  const outcome = { pending: 0, rejected: 0, notify: [] };

  for (const details of listed) {
    const complete = hasLicenceDetails(details);
    await applyVerificationState(
      details,
      details.user,
      complete ? "pending" : "rejected",
      { adminId, reason: complete ? null : reason, transaction },
    );
    if (complete) outcome.pending += 1;
    else outcome.rejected += 1;
    outcome.notify.push({ userId: details.userId, state: complete ? "pending" : "rejected", reason });
  }
  return outcome;
};

/**
 * Approves one waiting tradesperson automatically IF their trade needs no licence and they are a paying member.
 * Silent on purpose: no "profile approved" push or email, no admin alert, because nobody reviewed anything.
 * Safe to call repeatedly (webhook retries, the daily subscription re-sync). Rejected people are never touched
 * (they must resubmit), nor are test users. Returns { approved: boolean, reason }.
 */
const autoApproveIfUnlicensed = async (userId, { transaction } = {}) => {
  const details = await TradesmanDetails.findOne({ where: { userId }, transaction });
  if (!details) return { approved: false, reason: "NO_DETAILS" };
  if (details.isApproved) return { approved: false, reason: "ALREADY_APPROVED" };
  if (!["pending", "resubmitted"].includes(details.verificationStatus)) {
    return { approved: false, reason: "NOT_WAITING" };
  }

  const user = await User.findByPk(userId, { transaction });
  if (!user || user.role !== "tradesman") return { approved: false, reason: "NOT_A_TRADESMAN" };
  if (user.isDummy) return { approved: false, reason: "TEST_USER" };

  if (await isLicenceRequired(details.tradeTypeId, { transaction })) {
    return { approved: false, reason: "LICENCE_REQUIRED" };
  }

  // The profile must still be complete (trade, business name, bio and a profile photo); nothing else is needed.
  const missing = validateApprovalReadiness(details, { licenceRequired: false, profileImage: user.profileImage });
  if (missing.length) return { approved: false, reason: "INCOMPLETE_PROFILE", missing };

  if (!(await hasAccessibleSubscription(userId, { transaction }))) {
    return { approved: false, reason: "NOT_SUBSCRIBED" };
  }

  await applyVerificationState(details, user, "approved", { adminId: null, licenceVerified: false, transaction });
  return { approved: true, reason: null };
};

/** Turning a licence requirement OFF: everyone waiting in that trade who already pays is approved now. */
const autoApproveWaitingForTrade = async (tradeId, { transaction }) => {
  const waiting = await findWaitingSubscribed(tradeId, { transaction });
  let approved = 0;
  for (const details of waiting) {
    const result = await autoApproveIfUnlicensed(details.userId, { transaction });
    if (result.approved) approved += 1;
  }
  return approved;
};

module.exports = {
  MAX_LABEL_LENGTH,
  sanitizeLabel,
  hasLicenceDetails,
  countLicenceImpact,
  askListedForLicence,
  autoApproveIfUnlicensed,
  autoApproveWaitingForTrade,
};
