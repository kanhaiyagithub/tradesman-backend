/**
 * Central subscription plan configuration.
 *
 * This keeps pricing and travel-plan stop limits in one place so Stripe seeding,
 * API plan listing, and backend validation do not drift from each other.
 */
const SUBSCRIPTION_PLANS = [
  {
    key: "basic",
    name: "Basic",
    description: "Location + 2 stops + destination",
    priceMonthly: 19,
    currency: "aud",
    maxStopsPerTravelPlan: 2,
  },
  {
    key: "make_money",
    name: "Make Money",
    description: "Location + 5 stops + destination",
    priceMonthly: 44,
    currency: "aud",
    maxStopsPerTravelPlan: 5,
  },
  {
    key: "pro",
    name: "Pro",
    description: "Location + 10 stops + destination",
    priceMonthly: 99,
    currency: "aud",
    maxStopsPerTravelPlan: 10,
  },
];

const SUBSCRIPTION_PLAN_NAMES = SUBSCRIPTION_PLANS.map((plan) => plan.name);

const getSubscriptionPlanConfigByName = (name) =>
  SUBSCRIPTION_PLANS.find((plan) => plan.name === name) || null;

module.exports = {
  SUBSCRIPTION_PLANS,
  SUBSCRIPTION_PLAN_NAMES,
  getSubscriptionPlanConfigByName,
};
