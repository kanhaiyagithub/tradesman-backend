// controllers/subscriptionController.js

const Stripe = require("stripe");
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const SubscriptionPlan = require("../models/SubscriptionPlan");
const UserSubscription = require("../models/UserSubscription");
const User = require("../models/User");

const EARLY_ACCESS_LIMIT = 100;
const TRIAL_DAYS = 14;

const sendResponse = (res, statusCode, success, message, data = null) =>
  res.status(statusCode).json({ success, message, data });

/**
 * GET /api/subscriptions/plans
 */
exports.getPlans = async (req, res) => {
  try {
    const plans = await SubscriptionPlan.findAll({
      order: [["priceMonthly", "ASC"]],
    });

    return sendResponse(res, 200, true, "Plans fetched", plans);
  } catch (err) {
    console.error("getPlans error:", err);
    return sendResponse(res, 500, false, "Server error");
  }
};

/**
 * GET /api/subscriptions/my
 */
exports.getMySubscription = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return sendResponse(res, 401, false, "Unauthorized");

    const sub = await UserSubscription.findOne({
      where: { userId },
      include: [{ model: SubscriptionPlan, as: "plan" }],
      order: [["createdAt", "DESC"]],
    });

    return sendResponse(res, 200, true, "Current subscription", sub);
  } catch (err) {
    console.error("getMySubscription error:", err);
    return sendResponse(res, 500, false, "Server error");
  }
};

/**
 * POST /api/subscriptions/upgrade
 */
exports.upgradePlan = async (req, res) => {
  try {
    const userId = req.user?.id;
    const role = req.user?.role;
    const { planId } = req.body;

    if (!userId) return sendResponse(res, 401, false, "Unauthorized");
    if (role !== "tradesman")
      return sendResponse(res, 403, false, "Only tradesmen can upgrade plan");

    const plan = await SubscriptionPlan.findByPk(planId);
    if (!plan) return sendResponse(res, 404, false, "Plan not found");
    if (!plan.stripePriceId)
      return sendResponse(res, 400, false, "Stripe price not configured");

    const user = await User.findByPk(userId);
    if (!user) return sendResponse(res, 404, false, "User not found");

    let subscription = await UserSubscription.findOne({ where: { userId } });

    // Prevent duplicate active subscriptions
    if (subscription?.stripeSubscriptionId && subscription.status !== "canceled") {
      return sendResponse(res, 400, false, "User already has an active subscription");
    }

    if (!subscription) {
      subscription = await UserSubscription.create({
        userId,
        planId: plan.id,
        startDate: new Date(),
        status: "incomplete",
      });
    }

    // Create Stripe customer if not exists
    if (!subscription.stripeCustomerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: { userId },
      });

      subscription.stripeCustomerId = customer.id;
      await subscription.save();
    }

    // =============================
    // 🔥 EARLY ACCESS BUSINESS LOGIC
    // =============================

    const earlyAccessCount = await UserSubscription.count({
      where: { isEarlyAccess: true },
    });

    const isEarlyAccess = earlyAccessCount < EARLY_ACCESS_LIMIT;

    const stripeSubscriptionPayload = {
      customer: subscription.stripeCustomerId,
      items: [{ price: plan.stripePriceId }],
      payment_behavior: "default_incomplete",
      expand: ["latest_invoice.payment_intent"],
    };

    if (isEarlyAccess) {
      stripeSubscriptionPayload.trial_period_days = TRIAL_DAYS;

      stripeSubscriptionPayload.discounts = [
        { coupon: process.env.STRIPE_LIFETIME_COUPON_ID },
      ];

      subscription.isEarlyAccess = true;
      subscription.hasLifetimeDiscount = true;
      subscription.trialEndsAt = new Date(
        Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000
      );
    } else {
      subscription.isEarlyAccess = false;
      subscription.hasLifetimeDiscount = false;
      subscription.trialEndsAt = null;
    }

    // =============================
    // 🔥 CREATE STRIPE SUBSCRIPTION
    // =============================

    const stripeSub = await stripe.subscriptions.create(
      stripeSubscriptionPayload
    );

    subscription.stripeSubscriptionId = stripeSub.id;
    subscription.planId = plan.id;
    subscription.status = stripeSub.status; 
    await subscription.save();

    return sendResponse(res, 200, true, "Subscription created", {
      stripeSubscriptionId: stripeSub.id,
      clientSecret:
  stripeSub.latest_invoice?.payment_intent?.client_secret || null,
      earlyAccess: isEarlyAccess,
    });

  } catch (err) {
    console.error("upgradePlan error FULL:", err);
    return sendResponse(res, 500, false, "Server error");
  }
};