const { autoApproveIfUnlicensed } = require("./tradeLicenceService");
const { notifyAdminsTradesmanNeedsVerification } = require("./adminNotificationService");

/**
 * Everything that should happen once a tradesperson has an accessible (paid or trialing) subscription:
 *  - a trade without a licence has nothing to review, so they are approved and listed straight away;
 *  - a licence-required trade waits for an admin, so every admin is emailed (once each; repeats are ignored).
 * Safe to call from every place a subscription is created or synced (mobile sign-up, webhooks, the daily re-sync):
 * relying on one Stripe webhook alone meant no email whenever the webhook did not arrive. Never throws.
 */
const handleTradesmanSubscribed = async (userId) => {
  if (!userId) return;
  try {
    const result = await autoApproveIfUnlicensed(userId);
    if (!result.approved) {
      await notifyAdminsTradesmanNeedsVerification({ userId });
    }
  } catch (error) {
    console.error("Subscription follow-up error:", error.message);
  }
};

module.exports = { handleTradesmanSubscribed };
