const Stripe = require("stripe");
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const SubscriptionPlan = require("../models/SubscriptionPlan");
const UserSubscription = require("../models/UserSubscription");
const User = require("../models/User");

const TRIAL_DAYS = 14;
const APP_BASE_URL =
  process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 5000}`;

const sendResponse = (res, statusCode, success, message, data = null) =>
  res.status(statusCode).json({ success, message, data });

const getSuccessUrl = () =>
  `${APP_BASE_URL}/api/subscriptions/success?session_id={CHECKOUT_SESSION_ID}`;

const getCancelUrl = () => `${APP_BASE_URL}/api/subscriptions/cancel`;

const getLatestSubscriptionForUser = async (userId) => {
  return UserSubscription.findOne({
    where: { userId },
    include: [{ model: SubscriptionPlan, as: "plan" }],
    order: [["createdAt", "DESC"]],
  });
};

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

    const sub = await getLatestSubscriptionForUser(userId);
    return sendResponse(res, 200, true, "Current subscription", sub);
  } catch (err) {
    console.error("getMySubscription error:", err);
    return sendResponse(res, 500, false, "Server error");
  }
};

/**
 * POST /api/subscriptions/checkout-session
 */
exports.createCheckoutSession = async (req, res) => {
  try {
    const userId = req.user?.id;
    const role = req.user?.role;
    const { planId } = req.body;

    if (!userId) return sendResponse(res, 401, false, "Unauthorized");
    if (role !== "tradesman") {
      return sendResponse(res, 403, false, "Only tradesmen can subscribe");
    }

    const numericPlanId = Number(planId);
    if (!numericPlanId) {
      return sendResponse(res, 400, false, "planId is required");
    }

    const plan = await SubscriptionPlan.findByPk(numericPlanId);
    if (!plan) return sendResponse(res, 404, false, "Plan not found");
    if (!plan.stripePriceId) {
      return sendResponse(res, 400, false, "Stripe price not configured");
    }

    const user = await User.findByPk(userId);
    if (!user) return sendResponse(res, 404, false, "User not found");

    let localSubscription = await UserSubscription.findOne({
      where: { userId },
      order: [["createdAt", "DESC"]],
    });

    if (
      localSubscription &&
      ["active", "trialing", "past_due", "unpaid"].includes(
        localSubscription.status
      ) &&
      localSubscription.stripeSubscriptionId
    ) {
      return sendResponse(
        res,
        400,
        false,
        "User already has a subscription record. Manage the existing subscription first."
      );
    }

    if (!localSubscription || localSubscription.status === "canceled") {
      localSubscription = await UserSubscription.create({
        userId,
        planId: plan.id,
        startDate: new Date(),
        status: "incomplete",
      });
    } else {
      localSubscription.planId = plan.id;
      localSubscription.status = "incomplete";
      localSubscription.endDate = null;
      await localSubscription.save();
    }

    if (!localSubscription.stripeCustomerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        name: user.name,
        metadata: {
          userId: String(user.id),
          role: String(user.role),
        },
      });

      localSubscription.stripeCustomerId = customer.id;
      await localSubscription.save();
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: localSubscription.stripeCustomerId,
      client_reference_id: String(userId),
      metadata: {
        userId: String(userId),
        planId: String(plan.id),
      },
      line_items: [
        {
          price: plan.stripePriceId,
          quantity: 1,
        },
      ],
      subscription_data: {
        trial_period_days: TRIAL_DAYS,
        metadata: {
          userId: String(userId),
          planId: String(plan.id),
        },
      },
      success_url: getSuccessUrl(),
      cancel_url: getCancelUrl(),
    });

    return sendResponse(res, 200, true, "Checkout session created", {
      sessionId: session.id,
      url: session.url,
    });
  } catch (err) {
    console.error("createCheckoutSession error:", err);
    return sendResponse(res, 500, false, err.message || "Server error");
  }
};

/**
 * GET /api/subscriptions/success
 */
exports.successPage = async (req, res) => {
  return res.status(200).send(
    "Subscription checkout completed. You can close this page and return to the app."
  );
};

/**
 * GET /api/subscriptions/cancel
 */
exports.cancelPage = async (req, res) => {
  return res
    .status(200)
    .send("Subscription checkout was cancelled. You can return to the app.");
};