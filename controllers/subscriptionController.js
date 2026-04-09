const Stripe = require("stripe");
const { Op } = require("sequelize");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const SubscriptionPlan = require("../models/SubscriptionPlan");
const UserSubscription = require("../models/UserSubscription");
const User = require("../models/User");
const TravelPlan = require("../models/locationModel");

const TRIAL_DAYS = 14;
const APP_BASE_URL =
  process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 5000}`;

const sendResponse = (res, statusCode, success, message, data = null) =>
  res.status(statusCode).json({ success, message, data });

const getSuccessUrl = () =>
  `${APP_BASE_URL}/api/subscriptions/success?session_id={CHECKOUT_SESSION_ID}`;

const getCancelUrl = () => `${APP_BASE_URL}/api/subscriptions/cancel`;

const fromUnix = (value) => (value ? new Date(value * 1000) : null);

const getOrCreateStripeCustomerForUser = async (user) => {
  const latestSubscription = await UserSubscription.findOne({
    where: { userId: user.id },
    order: [["createdAt", "DESC"]],
  });

  if (latestSubscription?.stripeCustomerId) {
    return latestSubscription.stripeCustomerId;
  }

  const customer = await stripe.customers.create({
    email: user.email,
    name: user.name,
    metadata: {
      userId: String(user.id),
      role: String(user.role),
    },
  });

  return customer.id;
};

const getLatestSubscriptionForUser = async (userId) => {
  return UserSubscription.findOne({
    where: { userId },
    include: [{ model: SubscriptionPlan, as: "plan" }],
    order: [["createdAt", "DESC"]],
  });
};

const getManageableSubscriptionForUser = async (userId) => {
  return UserSubscription.findOne({
    where: {
      userId,
      status: {
        [Op.in]: ["active", "trialing"],
      },
    },
    include: [{ model: SubscriptionPlan, as: "plan" }],
    order: [["createdAt", "DESC"]],
  });
};

const getStripeSubscriptionWithItem = async (stripeSubscriptionId) => {
  const stripeSubscription = await stripe.subscriptions.retrieve(
    stripeSubscriptionId,
    {
      expand: ["items.data"],
    }
  );

  const stripeItem = stripeSubscription?.items?.data?.[0];

  if (!stripeItem) {
    throw new Error("Stripe subscription item not found");
  }

  return { stripeSubscription, stripeItem };
};

const getOpenPlanStopCount = async (userId) => {
  const openPlan = await TravelPlan.findOne({
    where: {
      tradesmanId: userId,
      status: "open",
      destinationDateTime: {
        [Op.gte]: new Date(),
      },
    },
    order: [["createdAt", "DESC"]],
  });

  if (!openPlan || !openPlan.allowStops) {
    return 0;
  }

  return Array.isArray(openPlan.stops) ? openPlan.stops.length : 0;
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

async function changePlan(req, res, mode) {
  try {
    const userId = req.user?.id;
    const role = req.user?.role;
    const targetPlanId = Number(req.body?.targetPlanId);

    if (!userId) return sendResponse(res, 401, false, "Unauthorized");
    if (role !== "tradesman") {
      return sendResponse(
        res,
        403,
        false,
        "Only tradesmen can change subscription plans"
      );
    }

    if (!targetPlanId) {
      return sendResponse(res, 400, false, "targetPlanId is required");
    }

    const localSubscription = await getManageableSubscriptionForUser(userId);

    if (!localSubscription || !localSubscription.plan) {
      return sendResponse(
        res,
        404,
        false,
        "No active or trialing subscription found"
      );
    }

    if (!localSubscription.stripeSubscriptionId) {
      return sendResponse(
        res,
        400,
        false,
        "Stripe subscription is missing for this user"
      );
    }

    const currentPlan = localSubscription.plan;
    const targetPlan = await SubscriptionPlan.findByPk(targetPlanId);

    if (!targetPlan) {
      return sendResponse(res, 404, false, "Target plan not found");
    }

    if (!targetPlan.stripePriceId) {
      return sendResponse(
        res,
        400,
        false,
        "Target plan does not have a Stripe price"
      );
    }

    if (currentPlan.id === targetPlan.id) {
      return sendResponse(
        res,
        400,
        false,
        "User is already on the selected plan"
      );
    }

    const currentAmount = Number(currentPlan.priceMonthly);
    const targetAmount = Number(targetPlan.priceMonthly);

    if (mode === "upgrade" && !(targetAmount > currentAmount)) {
      return sendResponse(
        res,
        400,
        false,
        "Target plan must be higher than current plan for upgrade"
      );
    }

    if (mode === "downgrade" && !(targetAmount < currentAmount)) {
      return sendResponse(
        res,
        400,
        false,
        "Target plan must be lower than current plan for downgrade"
      );
    }

    if (mode === "downgrade") {
      const currentOpenStopCount = await getOpenPlanStopCount(userId);
      const allowedStops = targetPlan.maxSharedLocations ?? 0;

      if (currentOpenStopCount > allowedStops) {
        return sendResponse(
          res,
          400,
          false,
          `Cannot downgrade now. Your current open travel plan has ${currentOpenStopCount} stop(s), but ${targetPlan.name} allows only ${allowedStops}.`
        );
      }
    }

    const { stripeItem } = await getStripeSubscriptionWithItem(
      localSubscription.stripeSubscriptionId
    );

    const updatePayload = {
      items: [
        {
          id: stripeItem.id,
          price: targetPlan.stripePriceId,
        },
      ],
      metadata: {
        userId: String(userId),
        planId: String(targetPlan.id),
      },
    };

    if (mode === "upgrade") {
      if (localSubscription.status === "trialing") {
        updatePayload.proration_behavior = "none";
      } else {
        updatePayload.proration_behavior = "always_invoice";
        updatePayload.payment_behavior = "pending_if_incomplete";
      }
    }

    if (mode === "downgrade") {
      updatePayload.proration_behavior = "none";
    }

    const updatedSubscription = await stripe.subscriptions.update(
      localSubscription.stripeSubscriptionId,
      updatePayload
    );

    return sendResponse(
      res,
      200,
      true,
      mode === "upgrade"
        ? "Subscription upgrade requested successfully"
        : "Subscription downgrade requested successfully",
      {
        currentPlan: currentPlan.name,
        targetPlan: targetPlan.name,
        stripeSubscriptionId: updatedSubscription.id,
        stripeStatus: updatedSubscription.status,
        pendingUpdate: updatedSubscription.pending_update || null,
        note: "Webhook will sync the final subscription state into the database.",
      }
    );
  } catch (err) {
    console.error(`${mode} plan error:`, err);
    return sendResponse(res, 500, false, err.message || "Server error");
  }
}

/**
 * POST /api/subscriptions/upgrade-plan
 */
exports.upgradePlan = async (req, res) => {
  return changePlan(req, res, "upgrade");
};

/**
 * POST /api/subscriptions/downgrade-plan
 */
exports.downgradePlan = async (req, res) => {
  return changePlan(req, res, "downgrade");
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

/**
 * POST /api/subscriptions/mobile/setup-intent
 */
exports.createMobileSetupIntent = async (req, res) => {
  try {
    const userId = req.user?.id;
    const role = req.user?.role;

    if (!userId) return sendResponse(res, 401, false, "Unauthorized");
    if (role !== "tradesman") {
      return sendResponse(
        res,
        403,
        false,
        "Only tradesmen can start mobile subscription setup"
      );
    }

    if (!process.env.STRIPE_EPHEMERAL_KEY_API_VERSION) {
      return sendResponse(
        res,
        500,
        false,
        "STRIPE_EPHEMERAL_KEY_API_VERSION is not configured"
      );
    }

    const existingSubscription = await getManageableSubscriptionForUser(userId);
    if (
      existingSubscription &&
      existingSubscription.stripeSubscriptionId &&
      ["active", "trialing"].includes(existingSubscription.status)
    ) {
      return sendResponse(
        res,
        400,
        false,
        "User already has an active or trialing subscription. Use upgrade/downgrade APIs instead."
      );
    }

    const user = await User.findByPk(userId);
    if (!user) {
      return sendResponse(res, 404, false, "User not found");
    }

    const customerId = await getOrCreateStripeCustomerForUser(user);

    const ephemeralKey = await stripe.ephemeralKeys.create(
      { customer: customerId },
      { apiVersion: process.env.STRIPE_EPHEMERAL_KEY_API_VERSION }
    );

    const setupIntent = await stripe.setupIntents.create({
      customer: customerId,
      automatic_payment_methods: { enabled: true },
      usage: "off_session",
      metadata: {
        userId: String(userId),
        role: String(role),
      },
    });

    return sendResponse(
      res,
      200,
      true,
      "Mobile setup intent created",
      {
        publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
        customerId,
        customerEphemeralKeySecret: ephemeralKey.secret,
        setupIntentClientSecret: setupIntent.client_secret,
        setupIntentId: setupIntent.id,
      }
    );
  } catch (err) {
    console.error("createMobileSetupIntent error:", err);
    return sendResponse(res, 500, false, err.message || "Server error");
  }
};


/**
 * POST /api/subscriptions/mobile/create-subscription
 */
exports.createMobileSubscription = async (req, res) => {
  try {
    const userId = req.user?.id;
    const role = req.user?.role;
    const planId = Number(req.body?.planId);
    const setupIntentId = req.body?.setupIntentId;

    if (!userId) return sendResponse(res, 401, false, "Unauthorized");
    if (role !== "tradesman") {
      return sendResponse(
        res,
        403,
        false,
        "Only tradesmen can create mobile subscriptions"
      );
    }

    if (!planId) {
      return sendResponse(res, 400, false, "planId is required");
    }

    if (!setupIntentId) {
      return sendResponse(res, 400, false, "setupIntentId is required");
    }

    const existingSubscription = await getManageableSubscriptionForUser(userId);
    if (
      existingSubscription &&
      existingSubscription.stripeSubscriptionId &&
      ["active", "trialing"].includes(existingSubscription.status)
    ) {
      return sendResponse(
        res,
        400,
        false,
        "User already has an active or trialing subscription. Use upgrade/downgrade APIs instead."
      );
    }

    const plan = await SubscriptionPlan.findByPk(planId);
    if (!plan) {
      return sendResponse(res, 404, false, "Plan not found");
    }

    if (!plan.stripePriceId) {
      return sendResponse(res, 400, false, "Stripe price not configured");
    }

    const user = await User.findByPk(userId);
    if (!user) {
      return sendResponse(res, 404, false, "User not found");
    }

    const setupIntent = await stripe.setupIntents.retrieve(setupIntentId);

    if (!setupIntent) {
      return sendResponse(res, 404, false, "SetupIntent not found");
    }

    if (setupIntent.status !== "succeeded") {
      return sendResponse(
        res,
        400,
        false,
        "SetupIntent is not completed yet"
      );
    }

    const customerId =
      typeof setupIntent.customer === "string"
        ? setupIntent.customer
        : setupIntent.customer?.id;

    const paymentMethodId =
      typeof setupIntent.payment_method === "string"
        ? setupIntent.payment_method
        : setupIntent.payment_method?.id;

    if (!customerId || !paymentMethodId) {
      return sendResponse(
        res,
        400,
        false,
        "SetupIntent does not contain a customer or payment method"
      );
    }

    const stripeCustomer = await stripe.customers.retrieve(customerId);

    if (
      stripeCustomer?.deleted ||
      String(stripeCustomer?.metadata?.userId || "") !== String(userId)
    ) {
      return sendResponse(
        res,
        403,
        false,
        "SetupIntent customer does not belong to this user"
      );
    }

    let localSubscription = await UserSubscription.findOne({
      where: { userId },
      order: [["createdAt", "DESC"]],
    });

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

    localSubscription.stripeCustomerId = customerId;
    await localSubscription.save();

    const stripeSubscription = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: plan.stripePriceId }],
      default_payment_method: paymentMethodId,
      trial_period_days: TRIAL_DAYS,
      payment_settings: {
        save_default_payment_method: "on_subscription",
      },
      metadata: {
        userId: String(userId),
        planId: String(plan.id),
      },
    });

    localSubscription.stripeSubscriptionId = stripeSubscription.id;
    localSubscription.status = stripeSubscription.status;
    localSubscription.trialEndsAt = fromUnix(stripeSubscription.trial_end);
    localSubscription.currentPeriodStart = fromUnix(
      stripeSubscription.current_period_start
    );
    localSubscription.currentPeriodEnd = fromUnix(
      stripeSubscription.current_period_end
    );
    localSubscription.cancelAtPeriodEnd =
      !!stripeSubscription.cancel_at_period_end;

    await localSubscription.save();

    return sendResponse(
      res,
      200,
      true,
      "Mobile subscription created successfully",
      {
        subscriptionId: stripeSubscription.id,
        status: stripeSubscription.status,
        trialEndsAt: localSubscription.trialEndsAt,
        note: "Webhook will continue syncing final subscription lifecycle updates.",
      }
    );
  } catch (err) {
    console.error("createMobileSubscription error:", err);
    return sendResponse(res, 500, false, err.message || "Server error");
  }
};