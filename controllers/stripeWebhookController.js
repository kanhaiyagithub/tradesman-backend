const Stripe = require("stripe");
const { Op } = require("sequelize");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const UserSubscription = require("../models/UserSubscription");
const SubscriptionPlan = require("../models/SubscriptionPlan");

const fromUnix = (value) => (value ? new Date(value * 1000) : null);

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
  localSubscription.status = stripeSubscription.status;
  localSubscription.currentPeriodStart = fromUnix(
    stripeSubscription.current_period_start
  );
  localSubscription.currentPeriodEnd = fromUnix(
    stripeSubscription.current_period_end
  );
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
        break;

      case "invoice.payment_failed":
        if (data.subscription) {
          await UserSubscription.update(
            { status: "past_due" },
            { where: { stripeSubscriptionId: data.subscription } }
          );
        }
        break;

      default:
        console.log("Unhandled webhook event:", event.type);
    }

    return res.json({ received: true });
  } catch (error) {
    console.error("Webhook processing failed:", error);
    return res.status(500).json({ error: "Webhook processing failed" });
  }
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