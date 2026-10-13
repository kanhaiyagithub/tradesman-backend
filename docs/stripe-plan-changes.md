# Changing Stripe plans and prices

Plans live in `config/subscriptionPlans.js` and are seeded into Stripe and the local `subscription_plans` table by `npm run subscriptions:seed` (`scripts/createStripePlan.js`, logic in `services/stripePlanSeedService.js`).

## What the seed does

- **One Stripe product per plan.** If the local plan row has a `stripeProductId` it is reused; a product is only created when none exists. Name, description and metadata (`planKey`, `maxStopsPerTravelPlan`) are updated in Stripe if they differ.
- **Prices are immutable.** When the amount or currency in the config differs from the current Stripe price, only a **new price** is created under the same product, and the local row's `stripePriceId` is pointed at it.
- **The old price is archived** (`active: false`) only after the local row was saved. If archiving fails, a warning is logged and the seed continues.
- **Idempotent.** Running it again with no config change creates and changes nothing.
- Legacy plan merging ("Basic Plan" into "Basic", "Pro Plan" into "Pro") and removal of unused unknown plans work as before. Unknown plans that still have subscribers are kept.

## How to change a price

1. Edit `priceMonthly` (or `currency`) for the plan in `config/subscriptionPlans.js`.
2. Preview: `npm run subscriptions:seed -- --dry-run`
3. Apply: `npm run subscriptions:seed`
4. Deploy. New checkouts, upgrades and downgrades use the new price automatically (they read `stripePriceId` from the local row).

## Existing subscribers keep their old price (grandfathering)

A subscriber keeps the price they signed up on. Archiving the old price only stops it being used for **new** subscriptions; it does not touch existing subscriptions or their renewals.

Moving existing subscribers to the new price is deliberately **not implemented**. If you ever want that, do it explicitly per subscriber (and tell them first).

The webhook sync (`syncSubscriptionFromStripe`) looks the plan up by the subscription's price. For a subscriber on an old, archived price that lookup finds nothing, and the code then keeps the subscriber's existing `planId`, so nothing breaks. (Covered by a test.)

## Test mode vs live mode (important)

Stripe test and live mode have completely separate products and prices. A test price ID does not exist in live mode.

- The script prints the Stripe mode (from the key prefix only; the key is never printed) and the database name before doing anything.
- A **live key** (`sk_live_`) with `NODE_ENV` not `production` is refused unless you pass `--allow-live`.
- If a stored product/price ID is not found in the Stripe account the key belongs to (typically test IDs with a live key), the script warns about a test/live mismatch and creates a fresh product and price.

**Before going live:** run the seed once with the **live** key against the **production** database, so the plan rows hold live price IDs. Never leave test price IDs in the production database.

```
# on the production server (NODE_ENV=production, live key in its .env)
npm run subscriptions:seed -- --dry-run
npm run subscriptions:seed
```

Running against production from a non-production machine needs `--allow-live`, and you must make sure `DB_*` points at the production database (check the "Database:" line the script prints first).

## Commands

| Command | Effect |
| --- | --- |
| `npm run subscriptions:seed` | Seed / update plans |
| `npm run subscriptions:seed -- --dry-run` | Print what would be created, updated or archived; changes nothing in Stripe or the database |
| `npm run subscriptions:seed -- --allow-live` | Allow a live Stripe key when `NODE_ENV` is not `production` |

## Limitations

- If Stripe objects are created and the database then fails, the new product/price is left unused in Stripe. Re-running the seed creates another price; archive the orphan in the dashboard.
- The local table stores the price amount but not the currency; the currency is compared against the Stripe price itself.
