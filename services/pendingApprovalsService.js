const { Op } = require("sequelize");
const TradesmanDetails = require("../models/TradesmanDetails");
const User = require("../models/User");
const { buildSubscribedExistsLiteral } = require("./subscriptionAccessService");

/**
 * Size of the admin review queue: subscribed tradesmen whose profile is new
 * (`pending`) or `resubmitted`. Rejected profiles wait on the tradesman, so they
 * are not counted. Same rule as the default GET /api/admin/tradesmen/pending list.
 */
const countAwaitingReview = async () => {
  const countStatus = (verificationStatus) =>
    TradesmanDetails.count({
      where: {
        isApproved: false,
        verificationStatus,
        [Op.and]: [buildSubscribedExistsLiteral("`TradesmanDetails`.`userId`")],
      },
      include: [
        { model: User, as: "user", attributes: [], where: { role: "tradesman" }, required: true },
      ],
    });

  const [pending, resubmitted] = await Promise.all([
    countStatus("pending"),
    countStatus("resubmitted"),
  ]);

  return { total: pending + resubmitted, pending, resubmitted };
};

module.exports = { countAwaitingReview };
