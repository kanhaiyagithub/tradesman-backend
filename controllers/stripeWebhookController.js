const Stripe = require("stripe");
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ✅ Correct direct model import
const UserSubscription = require("../models/UserSubscription");

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
    console.error("❌ Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log("✅ Webhook event received:", event.type);

  const data = event.data.object;

  try {
    switch (event.type) {

      case "checkout.session.completed":
        console.log("🟢 Checkout session completed");
        break;

     case "invoice.paid":
  if (!data.subscription) {
    console.log("⚠ invoice.paid received but no subscription ID found");
    break;
  }

  await UserSubscription.update(
    { status: "active" },
    { where: { stripeSubscriptionId: data.subscription } }
  );

  console.log("🟢 Subscription marked active:", data.subscription);
  break;
        await UserSubscription.update(
          { status: "active" },
          { where: { stripeSubscriptionId: data.subscription } }
        );
        console.log("🟢 Subscription marked active");
        break;

      case "invoice.payment_failed":
        await UserSubscription.update(
          { status: "past_due" },
          { where: { stripeSubscriptionId: data.subscription } }
        );
        console.log("🟡 Subscription marked past_due");
        break;

      case "customer.subscription.updated":
        await UserSubscription.update(
          { status: data.status }, // Stripe is source of truth
          { where: { stripeSubscriptionId: data.id } }
        );
        console.log("🔄 Subscription updated to:", data.status);
        break;

      case "customer.subscription.deleted":
        await UserSubscription.update(
          { status: "canceled" },
          { where: { stripeSubscriptionId: data.id } }
        );
        console.log("🔴 Subscription canceled");
        break;

      default:
        console.log("Unhandled event type:", event.type);
    }

    return res.json({ received: true });

  } catch (error) {
    console.error("❌ Webhook DB error:", error);
    return res.status(500).json({ error: "Webhook processing failed" });
  }
};