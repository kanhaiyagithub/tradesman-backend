const Stripe = require("stripe");
const { Op } = require("sequelize");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const UserSubscription = require("../models/UserSubscription");
const SubscriptionPlan = require("../models/SubscriptionPlan");
const StripeWebhookEvent = require("../models/StripeWebhookEvent");
const metaConversionService = require("../services/metaConversionService");
const { createAndSendNotification } = require("../services/notificationService");

const fromUnix = (value) => (value ? new Date(value * 1000) : null);

// Stripe statuses the local ENUM cannot store map to their closest access state.
const normalizeStripeStatus = (status) => {
  if (status === "incomplete_expired") return "canceled";
  if (status === "paused") return "unpaid";
  return status;
};

// Newer Stripe API versions moved the billing period from the subscription to
// its items, so read either shape.
const getPeriodUnix = (stripeSubscription, field) =>
  stripeSubscription[field] ?? stripeSubscription.items?.data?.[0]?.[field] ?? null;

const getInvoiceSubscriptionId = (invoice) => {
  const subscription =
    invoice.subscription ||
    invoice.parent?.subscription_details?.subscription ||
    null;

  return subscription && typeof subscription === "object"
    ? subscription.id
    : subscription;
};

const findLocalSubscription = async ({
  stripeSubscriptionId = null,
  stripeCustomerId = null,
  userId = null,
}) => {
  const conditions = [];

  if (stripeSubscriptionId) conditions.push({ stripeSubscriptionId });
  if (stripeCustomerId) conditions.push({ stripeCustomerId });
  if (userId) conditions.push({ userId });

  if (!conditions.length) return null;

  return UserSubscription.findOne({
    where: { [Op.or]: conditions },
    order: [["createdAt", "DESC"]],
  });
};

/**
 * Tells the user their card failed and points the app at the billing portal.
 * Never throws: a notification problem must not fail the webhook.
 */
const notifyPaymentFailed = async (invoice, stripeSubscriptionId) => {
  try {
    // A failed FIRST payment is shown by the app during checkout itself.
    if (invoice.billing_reason === "subscription_create") return;

    const localSubscription = await findLocalSubscription({
      stripeSubscriptionId,
      stripeCustomerId:
        invoice.customer && typeof invoice.customer === "object"
          ? invoice.customer.id
          : invoice.customer,
    });

    if (!localSubscription) return;

    await createAndSendNotification(
      localSubscription.userId,
      "Payment failed",
      "We couldn't process your latest subscription payment. Update your card to keep your access.",
      {
        type: "payment_failed",
        // The app should call POST /api/subscriptions/billing-portal for a fresh link.
        action: "open_billing_portal",
        stripeSubscriptionId: stripeSubscriptionId || "",
        attemptCount: invoice.attempt_count || "",
        nextPaymentAttempt: invoice.next_payment_attempt || "",
      }
    );
  } catch (error) {
    console.error("Payment failed notification error:", error.message);
  }
};

const syncSubscriptionFromStripe = async (stripeSubscription) => {
  const priceId = stripeSubscription.items?.data?.[0]?.price?.id || null;

  const plan = priceId
    ? await SubscriptionPlan.findOne({ where: { stripePriceId: priceId } })
    : null;

  let localSubscription = await findLocalSubscription({
    stripeSubscriptionId: stripeSubscription.id,
    stripeCustomerId: stripeSubscription.customer,
  });

  if (!localSubscription) {
    const customer = await stripe.customers.retrieve(stripeSubscription.customer);

    const userId = Number(
      customer?.metadata?.userId || stripeSubscription.metadata?.userId || 0
    );

    const planId = plan?.id || Number(stripeSubscription.metadata?.planId || 0);

    if (!userId || !planId) {
      console.log("No local subscription mapping found for Stripe subscription", {
        stripeSubscriptionId: stripeSubscription.id,
        stripeCustomerId: stripeSubscription.customer,
      });
      return;
    }

    localSubscription = await UserSubscription.create({
      userId,
      planId,
      startDate: new Date(),
      status: "incomplete",
    });
  }

  if (plan) {
    localSubscription.planId = plan.id;
  }

  localSubscription.stripeCustomerId =
    stripeSubscription.customer || localSubscription.stripeCustomerId;

  localSubscription.stripeSubscriptionId = stripeSubscription.id;
  localSubscription.status = normalizeStripeStatus(stripeSubscription.status);
  localSubscription.currentPeriodStart = fromUnix(
    getPeriodUnix(stripeSubscription, "current_period_start")
  );
  localSubscription.currentPeriodEnd = fromUnix(
    getPeriodUnix(stripeSubscription, "current_period_end")
  );
  localSubscription.lastSyncedAt = new Date();
  localSubscription.cancelAtPeriodEnd =
    !!stripeSubscription.cancel_at_period_end;
  localSubscription.trialEndsAt = fromUnix(stripeSubscription.trial_end);

  if (stripeSubscription.status === "canceled") {
    localSubscription.endDate = new Date();
  }

  await localSubscription.save();
};

exports.handleWebhook = async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;

  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    console.error("Stripe webhook secret is not configured");
    return res.status(500).json({ error: "Stripe webhook is not configured" });
  }

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const data = event.data.object;
  console.log("Stripe webhook received:", event.type);

  try {
    const [webhookEvent, created] = await StripeWebhookEvent.findOrCreate({
      where: { eventId: event.id },
      defaults: {
        eventId: event.id,
        eventType: event.type,
        status: "processing",
        processingStartedAt: new Date(),
      },
    });

    if (!created) {
      if (webhookEvent.status === "processed" && webhookEvent.processedAt) {
        return res.json({ received: true, duplicate: true });
      }

      if (webhookEvent.status === "processing") {
        return res.status(409).json({ received: true, processing: true });
      }

      await webhookEvent.update({
        status: "processing",
        processingStartedAt: new Date(),
        processedAt: null,
      });
    }

    switch (event.type) {
      case "checkout.session.completed": {
        const userId = Number(
          data.metadata?.userId || data.client_reference_id || 0
        );
        const planId = Number(data.metadata?.planId || 0);

        let localSubscription = await findLocalSubscription({
          stripeSubscriptionId: data.subscription,
          stripeCustomerId: data.customer,
          userId,
        });

        if (!localSubscription && userId && planId) {
          localSubscription = await UserSubscription.create({
            userId,
            planId,
            status: "incomplete",
            startDate: new Date(),
          });
        }

        if (localSubscription) {
          localSubscription.stripeCustomerId = data.customer;
          localSubscription.stripeSubscriptionId = data.subscription;
          if (planId) localSubscription.planId = planId;
          await localSubscription.save();
        }

        break;
      }

      case "customer.subscription.created":
      case "customer.subscription.updated":
        await syncSubscriptionFromStripe(data);
        break;

      case "customer.subscription.deleted":
        await syncSubscriptionFromStripe({
          ...data,
          status: "canceled",
        });
        break;

      case "invoice.paid":
        if (data.subscription) {
          await UserSubscription.update(
            { status: "active" },
            { where: { stripeSubscriptionId: data.subscription } }
          );
        }

        // Meta Conversions API: never throws; only the first paid invoice counts.
        await metaConversionService.trackSubscribeFromInvoice(data);
        break;

      case "invoice.payment_failed": {
        const failedSubscriptionId = getInvoiceSubscriptionId(data);

        if (failedSubscriptionId) {
          // past_due keeps access while Stripe retries the card, so only move
          // subscriptions that already had access (never a failed first payment).
          await UserSubscription.update(
            { status: "past_due" },
            {
              where: {
                stripeSubscriptionId: failedSubscriptionId,
                status: { [Op.in]: ["active", "trialing"] },
              },
            }
          );
        }

        await notifyPaymentFailed(data, failedSubscriptionId);
        break;
      }

      default:
        console.log("Unhandled webhook event:", event.type);
    }

    await webhookEvent.update({
      status: "processed",
      processedAt: new Date(),
    });

    return res.json({ received: true });
  } catch (error) {
    console.error("Webhook processing failed:", error);
    if (event?.id) {
      await StripeWebhookEvent.update(
        { status: "failed", processedAt: null },
        { where: { eventId: event.id } }
      );
    }
    return res.status(500).json({ error: "Webhook processing failed" });
  }
};

module.exports._private = {
  notifyPaymentFailed,
  getInvoiceSubscriptionId,
  findLocalSubscription,
  syncSubscriptionFromStripe,
};



// const Stripe = require("stripe");
// const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// // ✅ Correct direct model import
// const UserSubscription = require("../models/UserSubscription");

// exports.handleWebhook = async (req, res) => {
//   const sig = req.headers["stripe-signature"];

//   let event;

//   try {
//     event = stripe.webhooks.constructEvent(
//       req.body,
//       sig,
//       process.env.STRIPE_WEBHOOK_SECRET
//     );
//   } catch (err) {
//     console.error("❌ Webhook signature verification failed:", err.message);
//     return res.status(400).send(`Webhook Error: ${err.message}`);
//   }

//   console.log("✅ Webhook event received:", event.type);

//   const data = event.data.object;

//   try {
//     switch (event.type) {

//       case "checkout.session.completed":
//         console.log("🟢 Checkout session completed");
//         break;

//      case "invoice.paid":
//   if (!data.subscription) {
//     console.log("⚠ invoice.paid received but no subscription ID found");
//     break;
//   }

//   await UserSubscription.update(
//     { status: "active" },
//     { where: { stripeSubscriptionId: data.subscription } }
//   );

//   console.log("🟢 Subscription marked active:", data.subscription);
//   break;
//         await UserSubscription.update(
//           { status: "active" },
//           { where: { stripeSubscriptionId: data.subscription } }
//         );
//         console.log("🟢 Subscription marked active");
//         break;

//       case "invoice.payment_failed":
//         await UserSubscription.update(
//           { status: "past_due" },
//           { where: { stripeSubscriptionId: data.subscription } }
//         );
//         console.log("🟡 Subscription marked past_due");
//         break;

//       case "customer.subscription.updated":
//         await UserSubscription.update(
//           { status: data.status }, // Stripe is source of truth
//           { where: { stripeSubscriptionId: data.id } }
//         );
//         console.log("🔄 Subscription updated to:", data.status);
//         break;

//       case "customer.subscription.deleted":
//         await UserSubscription.update(
//           { status: "canceled" },
//           { where: { stripeSubscriptionId: data.id } }
//         );
//         console.log("🔴 Subscription canceled");
//         break;

//       default:
//         console.log("Unhandled event type:", event.type);
//     }

//     return res.json({ received: true });

//   } catch (error) {
//     console.error("❌ Webhook DB error:", error);
//     return res.status(500).json({ error: "Webhook processing failed" });
//   }
// };
