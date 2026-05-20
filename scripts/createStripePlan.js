require("dotenv").config();

const Stripe = require("stripe");

const SubscriptionPlan = require("../models/SubscriptionPlan");
const UserSubscription = require("../models/UserSubscription");
const sequelize = require("../config/db");
const { SUBSCRIPTION_PLANS } = require("../config/subscriptionPlans");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

/**
 * Old plan names that should be merged into the new 3-plan structure.
 *
 * This keeps existing user subscriptions safe before deleting old rows.
 */
const LEGACY_PLAN_MERGE_MAP = {
  "Basic Plan": "Basic",
  "Pro Plan": "Pro",
};

/**
 * Creates a Stripe product + monthly recurring price for a configured plan.
 *
 * Stripe prices are immutable, so when the amount changes we create a new price
 * and update the local subscription plan to point at the new Stripe price id.
 *
 * @param {object} planConfig - Plan config from config/subscriptionPlans.js.
 * @returns {Promise<{productId: string, priceId: string}>} Stripe ids.
 */
async function createStripeProductAndPrice(planConfig) {
  const product = await stripe.products.create({
    name: planConfig.name,
    description: planConfig.description,
    metadata: {
      planKey: planConfig.key,
      maxStopsPerTravelPlan: String(planConfig.maxStopsPerTravelPlan),
    },
  });

  const price = await stripe.prices.create({
    unit_amount: Math.round(planConfig.priceMonthly * 100),
    currency: planConfig.currency,
    recurring: { interval: "month" },
    product: product.id,
    metadata: {
      planKey: planConfig.key,
      maxStopsPerTravelPlan: String(planConfig.maxStopsPerTravelPlan),
    },
  });

  return {
    productId: product.id,
    priceId: price.id,
  };
}

/**
 * Inserts or updates a local subscription plan and keeps its stop limit synced.
 *
 * @param {object} planConfig - Plan config from config/subscriptionPlans.js.
 * @returns {Promise<SubscriptionPlan>} Created or updated subscription plan.
 */
async function upsertSubscriptionPlan(planConfig) {
  const existingPlan = await SubscriptionPlan.findOne({
    where: {
      name: planConfig.name,
    },
  });

  const expectedAmount = Number(planConfig.priceMonthly);
  const existingAmount = existingPlan ? Number(existingPlan.priceMonthly) : null;

  const needsStripePrice =
    !existingPlan?.stripePriceId || existingAmount !== expectedAmount;

  const stripeIds = needsStripePrice
    ? await createStripeProductAndPrice(planConfig)
    : {
        productId: existingPlan.stripeProductId,
        priceId: existingPlan.stripePriceId,
      };

  if (existingPlan) {
    await existingPlan.update({
      priceMonthly: planConfig.priceMonthly,
      stripeProductId: stripeIds.productId,
      stripePriceId: stripeIds.priceId,
      maxSharedLocations: planConfig.maxStopsPerTravelPlan,
      isDefault: false,
    });

    console.log(
      `Updated ${planConfig.name}: $${planConfig.priceMonthly}/${planConfig.currency.toUpperCase()} with ${planConfig.maxStopsPerTravelPlan} stop(s)`
    );

    return existingPlan;
  }

  const createdPlan = await SubscriptionPlan.create({
    name: planConfig.name,
    priceMonthly: planConfig.priceMonthly,
    stripeProductId: stripeIds.productId,
    stripePriceId: stripeIds.priceId,
    maxSharedLocations: planConfig.maxStopsPerTravelPlan,
    isDefault: false,
  });

  console.log(
    `Created ${planConfig.name}: $${planConfig.priceMonthly}/${planConfig.currency.toUpperCase()} with ${planConfig.maxStopsPerTravelPlan} stop(s)`
  );

  return createdPlan;
}

/**
 * Moves user subscriptions from old plan rows to the correct new plan rows,
 * then deletes the old legacy plan rows.
 *
 * This is what guarantees the subscription_plans table only keeps the 3
 * supported plans without breaking existing users.
 *
 * @returns {Promise<void>}
 */
async function mergeAndDeleteLegacyPlans() {
  const transaction = await sequelize.transaction();

  try {
    for (const [legacyPlanName, currentPlanName] of Object.entries(
      LEGACY_PLAN_MERGE_MAP
    )) {
      const legacyPlan = await SubscriptionPlan.findOne({
        where: {
          name: legacyPlanName,
        },
        transaction,
      });

      if (!legacyPlan) {
        continue;
      }

      const currentPlan = await SubscriptionPlan.findOne({
        where: {
          name: currentPlanName,
        },
        transaction,
      });

      if (!currentPlan) {
        throw new Error(
          `Cannot merge legacy plan "${legacyPlanName}" because "${currentPlanName}" does not exist`
        );
      }

      const movedSubscriptions = await UserSubscription.update(
        {
          planId: currentPlan.id,
        },
        {
          where: {
            planId: legacyPlan.id,
          },
          transaction,
        }
      );

      await legacyPlan.destroy({
        transaction,
      });

      console.log(
        `Merged legacy plan "${legacyPlanName}" into "${currentPlanName}" and deleted old row. Updated subscriptions: ${movedSubscriptions[0]}`
      );
    }

    await transaction.commit();
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

/**
 * Deletes any remaining unused plan rows that are not part of the official
 * Basic / Make Money / Pro configuration.
 *
 * If an unknown old plan still has subscriptions, it is kept for safety and
 * logged so you can manually decide where to move it.
 *
 * @returns {Promise<void>}
 */
async function removeUnusedUnknownPlans() {
  const allowedNames = SUBSCRIPTION_PLANS.map((plan) => plan.name);
  const allPlans = await SubscriptionPlan.findAll();

  for (const plan of allPlans) {
    if (allowedNames.includes(plan.name)) {
      continue;
    }

    const subscriptionCount = await UserSubscription.count({
      where: {
        planId: plan.id,
      },
    });

    if (subscriptionCount > 0) {
      console.warn(
        `Unknown old plan kept because it has ${subscriptionCount} subscription(s): ${plan.name}`
      );
      continue;
    }

    await plan.destroy();
    console.log(`Deleted unused unknown old plan: ${plan.name}`);
  }
}

/**
 * Seeds the official subscription plans.
 *
 * Final expected local DB plans:
 * - Basic: $19/month, 2 stops
 * - Make Money: $44/month, 5 stops
 * - Pro: $99/month, 10 stops
 */
async function seedSubscriptionPlans() {
  try {
    if (!process.env.STRIPE_SECRET_KEY) {
      throw new Error("STRIPE_SECRET_KEY is required to create Stripe prices");
    }

    await sequelize.authenticate();

    for (const planConfig of SUBSCRIPTION_PLANS) {
      await upsertSubscriptionPlan(planConfig);
    }

    await mergeAndDeleteLegacyPlans();
    await removeUnusedUnknownPlans();

    console.log("Subscription plans seeded successfully.");
    process.exit(0);
  } catch (err) {
    console.error("Failed to seed subscription plans:", err);
    process.exit(1);
  }
}

seedSubscriptionPlans();