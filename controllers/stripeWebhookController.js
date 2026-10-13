const Stripe = require("stripe");
const { Op } = require("sequelize");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const UserSubscription = require("../models/UserSubscription");
const SubscriptionPlan = require("../models/SubscriptionPlan");
const StripeWebhookEvent = require("../models/StripeWebhookEvent");
const metaConversionService = require("../services/metaConversionService");
const { createAndSendNotification } = require("../services/notificationService");
const User = require("../models/User");
const { toMajorUnits } = require("../utils/metaCapi");
const {
  sendSubscriptionWelcomeEmail,
  sendSubscriptionPaymentFailedEmail,
  sendSubscriptionCancelScheduledEmail,
  sendSubscriptionEndedEmail,
} = require("../services/emailService");

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

/* ===========================
   CUSTOMER EMAILS
   Every function below catches its own errors: an email problem must never
   fail (or cause a retry of) the webhook. Once-only sending is enforced by the
   email log key inside emailService.sendSubscriptionEmail, so a re-delivered
   or retried event cannot send a second copy.
   =========================== */

const customerIdOf = (invoice) =>
  invoice.customer && typeof invoice.customer === "object"
    ? invoice.customer.id
    : invoice.customer;

const getInvoiceMetadataUserId = (invoice) => {
  const candidates = [
    invoice.subscription_details?.metadata,
    invoice.parent?.subscription_details?.metadata,
    invoice.metadata,
    invoice.lines?.data?.[0]?.metadata,
  ];

  for (const metadata of candidates) {
    const userId = Number(metadata?.userId);
    if (userId) return userId;
  }

  return null;
};

const findInvoiceLocalSubscription = (invoice, stripeSubscriptionId) =>
  findLocalSubscription({
    stripeSubscriptionId,
    stripeCustomerId: customerIdOf(invoice),
  });

/** Welcome email: only for the FIRST paid invoice of a subscription. */
const emailWelcomeForInvoice = async (invoice, stripeSubscriptionId) => {
  try {
    if (
      invoice.billing_reason !== "subscription_create" ||
      !(Number(invoice.amount_paid) > 0) ||
      !stripeSubscriptionId
    ) {
      return;
    }

    const localSubscription = await findInvoiceLocalSubscription(invoice, stripeSubscriptionId);
    const userId = localSubscription?.userId || getInvoiceMetadataUserId(invoice);
    if (!userId) return;

    const user = await User.findByPk(userId);
    const plan = localSubscription?.planId
      ? await SubscriptionPlan.findByPk(localSubscription.planId)
      : null;
    const lineItem = invoice.lines?.data?.[0];

    await sendSubscriptionWelcomeEmail({
      user,
      stripeSubscriptionId,
      planName: plan?.name || lineItem?.description || "Touring Trades",
      amount: toMajorUnits(invoice.amount_paid, invoice.currency),
      currency: invoice.currency,
      renewalDate: localSubscription?.currentPeriodEnd || fromUnix(lineItem?.period?.end),
    });
  } catch (error) {
    console.error("Welcome email error:", error.message);
  }
};

/** Payment-failed email: not for the first payment (the app shows that at checkout). */
const emailPaymentFailedForInvoice = async (invoice, stripeSubscriptionId) => {
  try {
    if (invoice.billing_reason === "subscription_create") return;

    const localSubscription = await findInvoiceLocalSubscription(invoice, stripeSubscriptionId);
    if (!localSubscription) return;

    const user = await User.findByPk(localSubscription.userId);

    await sendSubscriptionPaymentFailedEmail({
      user,
      stripeSubscriptionId,
      invoiceId: invoice.id,
      attemptCount: invoice.attempt_count,
      nextAttemptDate: fromUnix(invoice.next_payment_attempt),
    });
  } catch (error) {
    console.error("Payment failed email error:", error.message);
  }
};

/** Reads the local row BEFORE it is synced, so changes can be detected. */
const snapshotLocalSubscription = async (stripeSubscription) => {
  try {
    const row = await findLocalSubscription({
      stripeSubscriptionId: stripeSubscription.id,
      stripeCustomerId: stripeSubscription.customer,
    });

    return row
      ? {
          userId: row.userId,
          status: row.status,
          cancelAtPeriodEnd: Boolean(row.cancelAtPeriodEnd),
          currentPeriodEnd: row.currentPeriodEnd,
        }
      : null;
  } catch (error) {
    console.error("Subscription snapshot error:", error.message);
    return null;
  }
};

const ACCESS_STATUSES_BEFORE_END = ["active", "trialing", "past_due", "unpaid"];

/**
 * Cancellation-scheduled (cancel_at_period_end false -> true) and
 * subscription-ended (-> canceled) emails. `previous` is the local row as it
 * was before syncing this Stripe event.
 */
const emailSubscriptionChange = async (previous, stripeSubscription) => {
  try {
    if (!previous) return;

    const user = await User.findByPk(previous.userId);

    if (stripeSubscription.status === "canceled") {
      if (ACCESS_STATUSES_BEFORE_END.includes(previous.status)) {
        await sendSubscriptionEndedEmail({
          user,
          stripeSubscriptionId: stripeSubscription.id,
        });
      }
      return;
    }

    if (!previous.cancelAtPeriodEnd && stripeSubscription.cancel_at_period_end === true) {
      await sendSubscriptionCancelScheduledEmail({
        user,
        stripeSubscriptionId: stripeSubscription.id,
        endDate:
          fromUnix(getPeriodUnix(stripeSubscription, "current_period_end")) ||
          fromUnix(stripeSubscription.cancel_at) ||
          previous.currentPeriodEnd,
      });
    }
  } catch (error) {
    console.error("Subscription change email error:", error.message);
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
        await syncSubscriptionFromStripe(data);
        break;

      case "customer.subscription.updated": {
        // Compare with the local row BEFORE syncing it. Sent before the sync so
        // a webhook retry after a failed sync cannot miss the email; the email
        // log key stops a retry from sending a second one.
        const previous = await snapshotLocalSubscription(data);
        await emailSubscriptionChange(previous, data);
        await syncSubscriptionFromStripe(data);
        break;
      }

      case "customer.subscription.deleted": {
        const previous = await snapshotLocalSubscription(data);
        await emailSubscriptionChange(previous, { ...data, status: "canceled" });
        await syncSubscriptionFromStripe({
          ...data,
          status: "canceled",
        });
        break;
      }

      case "invoice.paid": {
        // Newer Stripe API versions moved the id to invoice.parent.subscription_details.
        const paidSubscriptionId = getInvoiceSubscriptionId(data);

        if (paidSubscriptionId) {
          await UserSubscription.update(
            { status: "active" },
            { where: { stripeSubscriptionId: paidSubscriptionId } }
          );
        }

        // Meta Conversions API: never throws; only the first paid invoice counts.
        await metaConversionService.trackSubscribeFromInvoice(data);

        // Thank-you email for the first paid invoice only (never renewals or $0 invoices).
        await emailWelcomeForInvoice(data, paidSubscriptionId);
        break;
      }

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
        await emailPaymentFailedForInvoice(data, failedSubscriptionId);
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
