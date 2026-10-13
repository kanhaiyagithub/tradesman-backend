require("dotenv").config();

const Stripe = require("stripe");

const SubscriptionPlan = require("../models/SubscriptionPlan");
const UserSubscription = require("../models/UserSubscription");
const sequelize = require("../config/db");
const { SUBSCRIPTION_PLANS } = require("../config/subscriptionPlans");
const {
  getStripeKeyMode,
  assertSafeToRun,
  seedSubscriptionPlans,
} = require("../services/stripePlanSeedService");

/**
 * Seeds the official subscription plans (see services/stripePlanSeedService.js).
 *
 * Usage:
 *   npm run subscriptions:seed                    seed / update plans
 *   npm run subscriptions:seed -- --dry-run       print what would change, change nothing
 *   npm run subscriptions:seed -- --allow-live    allow a live Stripe key outside production
 *
 * Final expected local DB plans: Basic, Make Money, Pro (see config/subscriptionPlans.js).
 */
async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const allowLive = args.includes("--allow-live");

  // Only the key PREFIX is inspected; the key itself is never printed.
  const mode = assertSafeToRun({
    mode: getStripeKeyMode(process.env.STRIPE_SECRET_KEY),
    nodeEnv: process.env.NODE_ENV,
    allowLive,
  });

  console.log(`Stripe mode: ${mode.toUpperCase()}`);
  console.log(`Database: ${sequelize.config.database || process.env.DB_NAME}`);
  if (dryRun) console.log("DRY RUN: nothing will be changed in Stripe or the database.");

  await sequelize.authenticate();

  await seedSubscriptionPlans({
    stripe: new Stripe(process.env.STRIPE_SECRET_KEY),
    plans: SUBSCRIPTION_PLANS,
    SubscriptionPlan,
    UserSubscription,
    sequelize,
    dryRun,
  });

  console.log(dryRun ? "Dry run complete." : "Subscription plans seeded successfully.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Failed to seed subscription plans:", err.message);
    process.exit(1);
  });
