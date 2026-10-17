const Admin = require("../models/AdminModel/adminModel");
const User = require("../models/User");
const TradesmanDetails = require("../models/TradesmanDetails");
const { sendAdminTradesmanVerificationEmail } = require("./emailService");
const { publishApprovalsUpdate } = require("./adminEventService");

const getReviewUrl = (tradesmanId) => {
  const base = String(process.env.ADMIN_PANEL_URL || "").trim().replace(/\/+$/, "");
  return base ? `${base}/tradesmen/${tradesmanId}` : null;
};

/**
 * Tells every admin that a tradesman has registered AND subscribed and still
 * needs verifying. Does nothing for non-tradesmen or tradesmen who are already
 * approved. Never throws, so it can sit inside the Stripe webhook safely.
 */
const notifyAdminsTradesmanNeedsVerification = async ({
  userId,
  planName = null,
  isResubmission = false,
  previousReason = null,
}) => {
  try {
    const tradesman = await User.findByPk(userId);
    if (!tradesman || tradesman.role !== "tradesman") {
      return { notified: 0, reason: "NOT_A_TRADESMAN" };
    }

    const details = await TradesmanDetails.findOne({ where: { userId } });
    if (!details || details.isApproved) {
      return { notified: 0, reason: details ? "ALREADY_APPROVED" : "NO_DETAILS" };
    }

    // A first-time "please verify" email is only for a profile nobody has
    // reviewed yet. A rejected tradesman is waiting to resubmit, and a
    // resubmitted one already notified admins when they resubmitted.
    if (!isResubmission && details.verificationStatus !== "pending") {
      return { notified: 0, reason: "NOT_PENDING" };
    }

    // Live dashboard alert first, so a slow or failing email never delays it.
    await publishApprovalsUpdate({
      type: isResubmission ? "resubmitted" : "new",
      tradesman: {
        userId: tradesman.id,
        name: tradesman.name,
        businessName: details.businessName,
      },
    });

    const admins = await Admin.findAll();
    let notified = 0;

    for (const admin of admins) {
      const result = await sendAdminTradesmanVerificationEmail({
        admin,
        tradesman,
        details,
        planName,
        isResubmission,
        previousReason,
        reviewUrl: getReviewUrl(tradesman.id),
      });
      if (result.success && !result.skipped) notified += 1;
    }

    return { notified };
  } catch (error) {
    console.error("Admin verification notification error:", error.message);
    return { notified: 0, reason: error.message };
  }
};

module.exports = { notifyAdminsTradesmanNeedsVerification };
