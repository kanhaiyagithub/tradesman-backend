require("dotenv").config();
const Stripe = require("stripe");
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const SubscriptionPlan = require("../models/SubscriptionPlan");
const sequelize = require("../config/db");

async function createPlan() {
  try {
    await sequelize.sync();

    // 1️⃣ Create Product in Stripe
    const product = await stripe.products.create({
      name: "Premium Plan",
    });

    // 2️⃣ Create Price in Stripe
    const price = await stripe.prices.create({
      unit_amount: 2000, // $20.00
      currency: "aud",
      recurring: { interval: "month" },
      product: product.id,
    });

    console.log("Stripe Product:", product.id);
    console.log("Stripe Price:", price.id);

    // 3️⃣ Save in DB
    await SubscriptionPlan.create({
      name: "Premium Plan",
      priceMonthly: 20.0,
      stripePriceId: price.id,
      maxSharedLocations: null,
      isDefault: false,
    });

    console.log("Plan created successfully!");
    process.exit();
  } catch (err) {
    console.error(err);
  }
}

createPlan();