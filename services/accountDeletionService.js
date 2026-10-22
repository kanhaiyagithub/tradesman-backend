const Stripe = require("stripe");
const { Op } = require("sequelize");
const UserSubscription = require("../models/UserSubscription");
const TradesmanDetails = require("../models/TradesmanDetails");
const sequelize = require("../config/db");
const storageService = require("./storage/storageService");
const { deleteUserRecords } = require("./userRecordPurge");

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

const asList = (value) => {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return []; // MySQL may hand a JSON column back as text, so accept both
};

/**
 * Deletes a user and everything they own, then their uploaded files.
 *
 * The database rows go first, in one transaction: if that fails the account is left exactly as it was
 * (files included). The files are removed only afterwards, best effort, so a failed delete can never leave
 * a live account pointing at photos that no longer exist.
 *
 * Call cancelUserStripeSubscriptions first: this removes the local subscription rows but does not talk to Stripe.
 *
 * @returns {Promise<{ filesRemoved: number, sweptTables: string[] }>}
 */
const deleteUserAccount = async (user) => {
  const details = await TradesmanDetails.findOne({ where: { userId: user.id } });

  const files = [
    ...(user.profileImage ? [{ key: user.profileImage, category: "profile" }] : []),
    ...(details?.licenseDocument ? [{ key: details.licenseDocument, category: "license" }] : []),
    ...asList(details?.portfolioPhotos).map((key) => ({ key, category: "portfolio" })),
  ];

  const { sweptTables } = await sequelize.transaction((transaction) =>
    deleteUserRecords([user.id], transaction),
  );

  const results = await Promise.allSettled(
    files.map(({ key, category }) => storageService.deleteObject(key, { category })),
  );

  return {
    filesRemoved: results.filter((result) => result.status === "fulfilled").length,
    sweptTables,
  };
};

module.exports = { cancelUserStripeSubscriptions, deleteUserFiles, deleteUserAccount };
