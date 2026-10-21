const { Op } = require("sequelize");
const TradesmanDetails = require("../models/TradesmanDetails");
const User = require("../models/User");
const { buildSubscribedExistsLiteral } = require("./subscriptionAccessService");
const { buildLicenceRequiredLiteral } = require("./verificationStateService");

/**
 * Size of the admin review queue: subscribed tradesmen whose profile is new
 * (`pending`) or `resubmitted`. Rejected profiles wait on the tradesman, so they
 * are not counted. Same rule as the default GET /api/admin/tradesmen/pending list, except that
 * test (dummy) tradesmen are left out: they may be listed in the queue (flagged), but they must
 * not light up the badge or count as real work waiting.
 */
const countAwaitingReview = async () => {
  const countStatus = (verificationStatus) =>
    TradesmanDetails.count({
      where: {
        isApproved: false,
        verificationStatus,
        // Only licence-required trades need an admin; the rest are approved automatically when they subscribe.
        [Op.and]: [
          buildLicenceRequiredLiteral(),
          buildSubscribedExistsLiteral("`TradesmanDetails`.`userId`"),
        ],
      },
      include: [
        {
          model: User,
          as: "user",
          attributes: [],
          where: { role: "tradesman", isDummy: false },
          required: true,
        },
      ],
    });

  const [pending, resubmitted] = await Promise.all([
    countStatus("pending"),
    countStatus("resubmitted"),
  ]);

  return { total: pending + resubmitted, pending, resubmitted };
};

module.exports = { countAwaitingReview };
