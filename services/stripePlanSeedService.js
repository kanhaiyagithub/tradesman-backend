/**
 * Seeds the official subscription plans into Stripe and the local database.
 *
 * Rules:
 * - One Stripe product per plan. An existing local stripeProductId is reused.
 * - Stripe prices are immutable. When the amount or currency changes, only a
 *   new price is created under the existing product, the local row is pointed
 *   at it, and only then the old price is archived (active:false).
 * - Existing subscribers stay on their old price (grandfathering). Archiving a
 *   price does not affect subscriptions that already use it.
 * - Idempotent: with no config change a run creates and changes nothing.
 * - `dryRun` prints what would happen and changes nothing in Stripe or the DB.
 *
 * All dependencies are injected so the logic can be tested with fakes.
 */

const LEGACY_PLAN_MERGE_MAP = {
  "Basic Plan": "Basic",
  "Pro Plan": "Pro",
};

/** Returns "live", "test" or "unknown" from the key PREFIX only. */
const getStripeKeyMode = (key) => {
  const value = String(key || "");
  if (/^(sk|rk)_live_/.test(value)) return "live";
  if (/^(sk|rk)_test_/.test(value)) return "test";
  return "unknown";
};

/**
 * Refuses to run with an unusable key, or with a live key outside production
 * unless explicitly allowed. Never receives or prints the key itself.
 *
 * @returns {"live"|"test"} Stripe mode.
 */
const assertSafeToRun = ({ mode, nodeEnv, allowLive }) => {
  if (mode === "unknown") {
    throw new Error("STRIPE_SECRET_KEY is missing or is not a recognised Stripe secret key");
  }

  if (mode === "live" && nodeEnv !== "production" && !allowLive) {
    throw new Error(
      "Refusing to use a LIVE Stripe key while NODE_ENV is not production. " +
        "Pass --allow-live if you really intend to seed live plans."
    );
  }

  return mode;
};

const isMissingResource = (error) =>
  Boolean(error) && (error.code === "resource_missing" || error.statusCode === 404);

const toMinorUnits = (amount) => Math.round(Number(amount) * 100);

const buildProductMetadata = (planConfig) => ({
  planKey: planConfig.key,
  maxStopsPerTravelPlan: String(planConfig.maxStopsPerTravelPlan),
});

const describePlan = (planConfig) =>
  `$${planConfig.priceMonthly}/${planConfig.currency.toUpperCase()} with ${planConfig.maxStopsPerTravelPlan} stop(s)`;

const retrieveOrNull = async (retrieve, id) => {
  try {
    return await retrieve(id);
  } catch (error) {
    if (isMissingResource(error)) return null;
    throw error;
  }
};

/**
 * Seeds one plan. Returns what was done: { product, price, archived, row }.
 */
async function upsertSubscriptionPlan(planConfig, { stripe, SubscriptionPlan, dryRun, log }) {
  const say = (message) => log(dryRun ? `[DRY RUN] Would ${message}` : message);
  const result = { product: "unchanged", price: "unchanged", archived: false, row: "unchanged" };

  const existingPlan = await SubscriptionPlan.findOne({ where: { name: planConfig.name } });
  const expectedMetadata = buildProductMetadata(planConfig);
  // Captured before the row is updated: this is the price to archive later.
  const oldPriceId = existingPlan?.stripePriceId || null;

  // ---- current Stripe objects referenced by the local row ----
  let currentPrice = null;
  if (existingPlan?.stripePriceId) {
    currentPrice = await retrieveOrNull(
      (id) => stripe.prices.retrieve(id),
      existingPlan.stripePriceId
    );
    if (!currentPrice) {
      log(
        `WARNING: ${planConfig.name}: Stripe price ${existingPlan.stripePriceId} was not found in this Stripe account (test/live mismatch?). A new price will be created.`
      );
    }
  }

  let productId = existingPlan?.stripeProductId || null;
  if (!productId && currentPrice) {
    productId = typeof currentPrice.product === "object" ? currentPrice.product.id : currentPrice.product;
  }

  // ---- product: reuse, update if different, or create ----
  let product = null;
  if (productId) {
    product = await retrieveOrNull((id) => stripe.products.retrieve(id), productId);
    if (!product) {
      log(
        `WARNING: ${planConfig.name}: Stripe product ${productId} was not found in this Stripe account (test/live mismatch?). A new product will be created.`
      );
      productId = null;
    }
  }

  if (product) {
    const metadata = product.metadata || {};
    const differs =
      product.name !== planConfig.name ||
      (product.description || "") !== planConfig.description ||
      metadata.planKey !== expectedMetadata.planKey ||
      metadata.maxStopsPerTravelPlan !== expectedMetadata.maxStopsPerTravelPlan;

    if (differs) {
      say(`update product ${product.id} for ${planConfig.name} (name/description/metadata)`);
      if (!dryRun) {
        await stripe.products.update(product.id, {
          name: planConfig.name,
          description: planConfig.description,
          metadata: expectedMetadata,
        });
      }
      result.product = "updated";
    }
  } else {
    say(`create product for ${planConfig.name}`);
    if (!dryRun) {
      const created = await stripe.products.create({
        name: planConfig.name,
        description: planConfig.description,
        metadata: expectedMetadata,
      });
      productId = created.id;
    } else {
      productId = "prod_(new)";
    }
    result.product = "created";
  }

  if (product) productId = product.id;

  // ---- price: only create a new one when amount/currency/product changed ----
  const currentPriceProductId = currentPrice
    ? typeof currentPrice.product === "object"
      ? currentPrice.product.id
      : currentPrice.product
    : null;

  const needsNewPrice =
    !currentPrice ||
    currentPrice.active === false ||
    Number(currentPrice.unit_amount) !== toMinorUnits(planConfig.priceMonthly) ||
    String(currentPrice.currency).toLowerCase() !== planConfig.currency.toLowerCase() ||
    currentPrice.recurring?.interval !== "month" ||
    (result.product === "created" ? true : currentPriceProductId !== productId);

  let newPriceId = existingPlan?.stripePriceId || null;

  if (needsNewPrice) {
    say(`create price ${describePlan(planConfig)} under product ${productId} for ${planConfig.name}`);
    if (!dryRun) {
      const created = await stripe.prices.create({
        unit_amount: toMinorUnits(planConfig.priceMonthly),
        currency: planConfig.currency,
        recurring: { interval: "month" },
        product: productId,
        metadata: expectedMetadata,
      });
      newPriceId = created.id;
    } else {
      newPriceId = "price_(new)";
    }
    result.price = "created";
  }

  // ---- local row: write only when something differs ----
  const desired = {
    priceMonthly: planConfig.priceMonthly,
    stripeProductId: productId,
    stripePriceId: newPriceId,
    maxSharedLocations: planConfig.maxStopsPerTravelPlan,
    isDefault: false,
  };

  let rowSaved = false;

  if (existingPlan) {
    const rowDiffers =
      Number(existingPlan.priceMonthly) !== Number(desired.priceMonthly) ||
      existingPlan.stripeProductId !== desired.stripeProductId ||
      existingPlan.stripePriceId !== desired.stripePriceId ||
      Number(existingPlan.maxSharedLocations) !== Number(desired.maxSharedLocations) ||
      Boolean(existingPlan.isDefault) !== desired.isDefault;

    if (rowDiffers) {
      say(`update local plan row ${planConfig.name}: ${describePlan(planConfig)}`);
      if (!dryRun) {
        await existingPlan.update(desired);
        rowSaved = true;
      }
      result.row = "updated";
    }
  } else {
    say(`create local plan row ${planConfig.name}: ${describePlan(planConfig)}`);
    if (!dryRun) {
      await SubscriptionPlan.create({ name: planConfig.name, ...desired });
      rowSaved = true;
    }
    result.row = "created";
  }

  // ---- archive the old price, only after the local row was saved ----
  const shouldArchive =
    result.price === "created" && oldPriceId && oldPriceId !== newPriceId && currentPrice && currentPrice.active !== false;

  if (shouldArchive) {
    say(`archive old price ${oldPriceId} for ${planConfig.name} (existing subscribers keep it)`);
    if (!dryRun && rowSaved) {
      try {
        await stripe.prices.update(oldPriceId, { active: false });
        result.archived = true;
      } catch (error) {
        log(`WARNING: could not archive old price ${oldPriceId} for ${planConfig.name}: ${error.message}`);
      }
    } else if (dryRun) {
      result.archived = true;
    }
  }

  if (result.product === "unchanged" && result.price === "unchanged" && result.row === "unchanged") {
    log(`${planConfig.name}: up to date (${describePlan(planConfig)})`);
  } else if (!dryRun) {
    log(`${planConfig.name}: done (${describePlan(planConfig)})`);
  }

  return result;
}

/**
 * Moves user subscriptions from legacy plan rows to the current plan rows and
 * deletes the legacy rows. Behaviour is unchanged from the original script.
 */
async function mergeAndDeleteLegacyPlans({ SubscriptionPlan, UserSubscription, sequelize, dryRun, log }) {
  const transaction = dryRun ? null : await sequelize.transaction();

  try {
    for (const [legacyPlanName, currentPlanName] of Object.entries(LEGACY_PLAN_MERGE_MAP)) {
      const legacyPlan = await SubscriptionPlan.findOne({
        where: { name: legacyPlanName },
        ...(transaction ? { transaction } : {}),
      });

      if (!legacyPlan) continue;

      const currentPlan = await SubscriptionPlan.findOne({
        where: { name: currentPlanName },
        ...(transaction ? { transaction } : {}),
      });

      if (!currentPlan) {
        if (dryRun) {
          log(`[DRY RUN] Would fail: cannot merge legacy plan "${legacyPlanName}" because "${currentPlanName}" does not exist yet`);
          continue;
        }
        throw new Error(
          `Cannot merge legacy plan "${legacyPlanName}" because "${currentPlanName}" does not exist`
        );
      }

      if (dryRun) {
        const count = await UserSubscription.count({ where: { planId: legacyPlan.id } });
        log(`[DRY RUN] Would merge legacy plan "${legacyPlanName}" into "${currentPlanName}" (${count} subscription(s)) and delete the old row`);
        continue;
      }

      const movedSubscriptions = await UserSubscription.update(
        { planId: currentPlan.id },
        { where: { planId: legacyPlan.id }, transaction }
      );

      await legacyPlan.destroy({ transaction });

      log(
        `Merged legacy plan "${legacyPlanName}" into "${currentPlanName}" and deleted old row. Updated subscriptions: ${movedSubscriptions[0]}`
      );
    }

    if (transaction) await transaction.commit();
  } catch (error) {
    if (transaction) await transaction.rollback();
    throw error;
  }
}

/**
 * Deletes unused plan rows that are not part of the official configuration.
 * Unknown plans that still have subscriptions are kept and logged.
 */
async function removeUnusedUnknownPlans({ plans, SubscriptionPlan, UserSubscription, dryRun, log }) {
  const allowedNames = plans.map((plan) => plan.name);
  const allPlans = await SubscriptionPlan.findAll();

  for (const plan of allPlans) {
    if (allowedNames.includes(plan.name)) continue;

    const subscriptionCount = await UserSubscription.count({ where: { planId: plan.id } });

    if (subscriptionCount > 0) {
      log(`WARNING: Unknown old plan kept because it has ${subscriptionCount} subscription(s): ${plan.name}`);
      continue;
    }

    if (dryRun) {
      log(`[DRY RUN] Would delete unused unknown old plan: ${plan.name}`);
      continue;
    }

    await plan.destroy();
    log(`Deleted unused unknown old plan: ${plan.name}`);
  }
}

/**
 * Runs the whole seed.
 *
 * @param {object} deps
 * @param {object} deps.stripe - Stripe client (or a fake).
 * @param {object[]} deps.plans - Plan configs (config/subscriptionPlans.js).
 * @param {object} deps.SubscriptionPlan - Sequelize model.
 * @param {object} deps.UserSubscription - Sequelize model.
 * @param {object} deps.sequelize - Sequelize instance (transactions).
 * @param {boolean} [deps.dryRun]
 * @param {Function} [deps.log]
 */
async function seedSubscriptionPlans(deps) {
  const { stripe, plans, SubscriptionPlan, UserSubscription, sequelize } = deps;
  const dryRun = Boolean(deps.dryRun);
  const log = deps.log || console.log;
  const results = {};

  for (const planConfig of plans) {
    results[planConfig.name] = await upsertSubscriptionPlan(planConfig, {
      stripe,
      SubscriptionPlan,
      dryRun,
      log,
    });
  }

  await mergeAndDeleteLegacyPlans({ SubscriptionPlan, UserSubscription, sequelize, dryRun, log });
  await removeUnusedUnknownPlans({ plans, SubscriptionPlan, UserSubscription, dryRun, log });

  return results;
}

module.exports = {
  LEGACY_PLAN_MERGE_MAP,
  getStripeKeyMode,
  assertSafeToRun,
  upsertSubscriptionPlan,
  mergeAndDeleteLegacyPlans,
  removeUnusedUnknownPlans,
  seedSubscriptionPlans,
};
