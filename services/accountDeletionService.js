const Stripe = require("stripe");
const { Op } = require("sequelize");
const UserSubscription = require("../models/UserSubscription");
const TradesmanDetails = require("../models/TradesmanDetails");
const storageService = require("./storage/storageService");

const LIVE_STATUSES = ["active", "trialing", "past_due", "incomplete", "unpaid"];

/**
 * Cancels every live Stripe subscription of a user immediately so a deleted
 * account is never billed again. Throws if Stripe fails (the caller must then
 * keep the account); a subscription Stripe no longer knows about is fine.
 */
const cancelUserStripeSubscriptions = async (userId) => {
  const rows = await UserSubscription.findAll({
    where: {
      userId,
      stripeSubscriptionId: { [Op.ne]: null },
      status: { [Op.in]: LIVE_STATUSES },
    },
  });

  if (!rows.length) return 0;

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  let canceled = 0;

  for (const row of rows) {
    try {
      await stripe.subscriptions.cancel(row.stripeSubscriptionId);
      canceled += 1;
    } catch (error) {
      if (error?.code === "resource_missing" || error?.statusCode === 404) continue;
      throw error;
    }
  }

  return canceled;
};

/** Best-effort removal of a user's uploaded files; never throws. */
const deleteUserFiles = async (user) => {
  const removals = [];

  if (user.profileImage) {
    removals.push(storageService.deleteObject(user.profileImage, { category: "profile" }));
  }

  const details = await TradesmanDetails.findOne({ where: { userId: user.id } });
  if (details) {
    if (details.licenseDocument) {
      removals.push(
        storageService.deleteObject(details.licenseDocument, { category: "license" }),
      );
    }
    const photos = Array.isArray(details.portfolioPhotos) ? details.portfolioPhotos : [];
    if (photos.length) {
      removals.push(storageService.deleteObjects(photos, { category: "portfolio" }));
    }
  }

  await Promise.allSettled(removals);
};

module.exports = { cancelUserStripeSubscriptions, deleteUserFiles };
