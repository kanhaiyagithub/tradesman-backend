const assert = require("node:assert/strict");
const test = require("node:test");

// Dead DB + fake Stripe key BEFORE anything can load config/db or Stripe, so
// nothing here can reach a real database or the real Stripe API.
process.env.DB_HOST = "127.0.0.1";
process.env.DB_PORT = "1";
process.env.DB_NAME = "seed_test_unused";
process.env.DB_USER = "unused";
process.env.DB_PASS = "unused";
process.env.STRIPE_SECRET_KEY = "sk_test_fake_not_real";

const {
  getStripeKeyMode,
  assertSafeToRun,
  seedSubscriptionPlans,
} = require("../services/stripePlanSeedService");

const PLANS = [
  { key: "basic", name: "Basic", description: "Basic desc", priceMonthly: 19, currency: "aud", maxStopsPerTravelPlan: 2 },
  { key: "pro", name: "Pro", description: "Pro desc", priceMonthly: 99, currency: "aud", maxStopsPerTravelPlan: 10 },
];

// ------------------------------------------------------------------ fakes

const createFakeStripe = ({ failArchive = false } = {}) => {
  const products = new Map();
  const prices = new Map();
  const calls = [];
  let counter = 0;

  const notFound = (id) => {
    const error = new Error(`No such object: ${id}`);
    error.code = "resource_missing";
    return error;
  };

  return {
    products,
    prices,
    calls,
    stripe: {
      products: {
        retrieve: async (id) => {
          calls.push(["products.retrieve", id]);
          if (!products.has(id)) throw notFound(id);
          return products.get(id);
        },
        create: async (params) => {
          counter += 1;
          const product = { id: `prod_${counter}`, active: true, ...params };
          products.set(product.id, product);
          calls.push(["products.create", product.id]);
          return product;
        },
        update: async (id, params) => {
          Object.assign(products.get(id), params);
          calls.push(["products.update", id]);
          return products.get(id);
        },
      },
      prices: {
        retrieve: async (id) => {
          calls.push(["prices.retrieve", id]);
          if (!prices.has(id)) throw notFound(id);
          return prices.get(id);
        },
        create: async (params) => {
          counter += 1;
          const price = { id: `price_${counter}`, active: true, ...params };
          prices.set(price.id, price);
          calls.push(["prices.create", price.id]);
          return price;
        },
        update: async (id, params) => {
          if (failArchive) throw new Error("stripe archive failed");
          Object.assign(prices.get(id), params);
          calls.push(["prices.update", id, params]);
          return prices.get(id);
        },
      },
    },
  };
};

const createFakeDb = (initialRows = [], { subscriptions = [] } = {}) => {
  const rows = initialRows.map((row, index) => ({ id: index + 1, ...row }));
  const events = [];
  let nextId = rows.length + 1;

  const attach = (row) => {
    row.update = async (values) => {
      events.push(["row.update", row.name]);
      Object.assign(row, values);
    };
    row.destroy = async () => {
      events.push(["row.destroy", row.name]);
      rows.splice(rows.indexOf(row), 1);
    };
    return row;
  };
  rows.forEach(attach);

  return {
    rows,
    events,
    SubscriptionPlan: {
      findOne: async ({ where }) => rows.find((row) => row.name === where.name) || null,
      findAll: async () => [...rows],
      create: async (values) => {
        events.push(["row.create", values.name]);
        const row = attach({ id: nextId++, ...values });
        rows.push(row);
        return row;
      },
    },
    UserSubscription: {
      count: async ({ where }) => subscriptions.filter((s) => s.planId === where.planId).length,
      update: async ({ planId }, { where }) => {
        const moved = subscriptions.filter((s) => s.planId === where.planId);
        moved.forEach((s) => {
          s.planId = planId;
        });
        events.push(["subs.move", moved.length]);
        return [moved.length];
      },
    },
    sequelize: {
      transaction: async () => ({ commit: async () => {}, rollback: async () => {} }),
    },
  };
};

const run = (fake, db, overrides = {}) =>
  seedSubscriptionPlans({
    stripe: fake.stripe,
    plans: PLANS,
    ...db,
    log: () => {},
    ...overrides,
  });

const writeCalls = (fake) =>
  fake.calls.filter(([name]) => /\.(create|update)$/.test(name));

// ------------------------------------------------------------------ tests

test("first run creates one product and one price per plan and saves the rows", async () => {
  const fake = createFakeStripe();
  const db = createFakeDb();

  await run(fake, db);

  assert.equal(fake.products.size, 2);
  assert.equal(fake.prices.size, 2);
  assert.equal(db.rows.length, 2);

  const basic = db.rows.find((row) => row.name === "Basic");
  assert.equal(fake.prices.get(basic.stripePriceId).unit_amount, 1900);
  assert.equal(fake.prices.get(basic.stripePriceId).product, basic.stripeProductId);
  assert.equal(basic.maxSharedLocations, 2);
});

test("running twice with no config change creates and changes nothing", async () => {
  const fake = createFakeStripe();
  const db = createFakeDb();

  await run(fake, db);
  const callsAfterFirst = fake.calls.length;
  const eventsAfterFirst = db.events.length;

  await run(fake, db);

  const secondRun = fake.calls.slice(callsAfterFirst);
  assert.equal(secondRun.filter(([name]) => /\.(create|update)$/.test(name)).length, 0);
  assert.equal(db.events.length, eventsAfterFirst);
  assert.equal(fake.products.size, 2);
  assert.equal(fake.prices.size, 2);
});

test("a price change reuses the product, creates only a new price and archives the old one", async () => {
  const fake = createFakeStripe();
  const db = createFakeDb();
  await run(fake, db);

  const before = db.rows.find((row) => row.name === "Pro");
  const oldPriceId = before.stripePriceId;
  const productId = before.stripeProductId;
  const callsBefore = fake.calls.length;
  const eventsBefore = db.events.length;

  const changed = PLANS.map((plan) => (plan.key === "pro" ? { ...plan, priceMonthly: 109 } : plan));
  await run(fake, db, { plans: changed });

  const writes = writeCalls({ calls: fake.calls.slice(callsBefore) }).map(([name]) => name);
  assert.deepEqual(writes, ["prices.create", "prices.update"]);

  assert.equal(fake.products.size, 2, "no extra product");
  const after = db.rows.find((row) => row.name === "Pro");
  assert.equal(after.stripeProductId, productId);
  assert.notEqual(after.stripePriceId, oldPriceId);
  assert.equal(after.priceMonthly, 109);
  assert.equal(fake.prices.get(after.stripePriceId).unit_amount, 10900);
  assert.equal(fake.prices.get(after.stripePriceId).product, productId);
  assert.equal(fake.prices.get(oldPriceId).active, false);

  // The row is saved before the old price is archived.
  const rowUpdateIndex = db.events.slice(eventsBefore).findIndex(([name]) => name === "row.update");
  assert.ok(rowUpdateIndex >= 0);
  const createIndex = fake.calls.findIndex(
    (call, i) => i >= callsBefore && call[0] === "prices.create"
  );
  const archiveIndex = fake.calls.findIndex((call) => call[0] === "prices.update");
  assert.ok(archiveIndex > createIndex);
});

test("a currency change also creates a new price", async () => {
  const fake = createFakeStripe();
  const db = createFakeDb();
  await run(fake, db);
  const callsBefore = fake.calls.length;

  const changed = PLANS.map((plan) => (plan.key === "basic" ? { ...plan, currency: "usd" } : plan));
  await run(fake, db, { plans: changed });

  const created = fake.calls.slice(callsBefore).filter(([name]) => name === "prices.create");
  assert.equal(created.length, 1);
  assert.equal(fake.prices.get(created[0][1]).currency, "usd");
});

test("an existing product is reused and updated when its details differ", async () => {
  const fake = createFakeStripe();
  const db = createFakeDb();
  await run(fake, db);

  const basic = db.rows.find((row) => row.name === "Basic");
  const callsBefore = fake.calls.length;

  const changed = PLANS.map((plan) =>
    plan.key === "basic" ? { ...plan, description: "New description", maxStopsPerTravelPlan: 3 } : plan
  );
  await run(fake, db, { plans: changed });

  const writes = fake.calls.slice(callsBefore).filter(([name]) => /\.(create|update)$/.test(name));
  assert.deepEqual(writes.map(([name]) => name), ["products.update"]);
  assert.equal(fake.products.size, 2);
  assert.equal(fake.products.get(basic.stripeProductId).description, "New description");
  assert.equal(fake.products.get(basic.stripeProductId).metadata.maxStopsPerTravelPlan, "3");
});

test("a failure archiving the old price only warns and does not fail the seed", async () => {
  const fake = createFakeStripe({ failArchive: true });
  const db = createFakeDb();
  const logs = [];

  await run(fake, db, { log: (message) => logs.push(message) });
  const changed = PLANS.map((plan) => (plan.key === "pro" ? { ...plan, priceMonthly: 120 } : plan));

  await assert.doesNotReject(() => run(fake, db, { plans: changed, log: (m) => logs.push(m) }));

  assert.ok(logs.some((message) => /could not archive old price/.test(message)));
  const pro = db.rows.find((row) => row.name === "Pro");
  assert.equal(fake.prices.get(pro.stripePriceId).unit_amount, 12000);
});

test("dry run changes nothing in Stripe or the database", async () => {
  const fake = createFakeStripe();
  const db = createFakeDb();
  await run(fake, db);

  const snapshot = JSON.stringify(db.rows.map((row) => ({ ...row })));
  const prices = fake.prices.size;
  const callsBefore = fake.calls.length;
  const eventsBefore = db.events.length;
  const logs = [];

  const changed = PLANS.map((plan) => (plan.key === "pro" ? { ...plan, priceMonthly: 150 } : plan));
  await run(fake, db, { plans: changed, dryRun: true, log: (m) => logs.push(m) });

  assert.equal(
    fake.calls.slice(callsBefore).filter(([name]) => /\.(create|update)$/.test(name)).length,
    0
  );
  assert.equal(fake.prices.size, prices);
  assert.equal(db.events.length, eventsBefore);
  assert.equal(JSON.stringify(db.rows.map((row) => ({ ...row }))), snapshot);
  assert.ok(logs.some((message) => /\[DRY RUN\] Would create price/.test(message)));
  assert.ok(logs.some((message) => /\[DRY RUN\] Would archive old price/.test(message)));
});

test("dry run on an empty database creates nothing", async () => {
  const fake = createFakeStripe();
  const db = createFakeDb();

  await run(fake, db, { dryRun: true });

  assert.equal(fake.products.size, 0);
  assert.equal(fake.prices.size, 0);
  assert.equal(db.rows.length, 0);
});

test("ids missing from this Stripe account (test/live mismatch) get a fresh product and price", async () => {
  const fake = createFakeStripe();
  const db = createFakeDb([
    {
      name: "Basic",
      priceMonthly: 19,
      stripeProductId: "prod_TEST_ONLY",
      stripePriceId: "price_TEST_ONLY",
      maxSharedLocations: 2,
      isDefault: false,
    },
  ]);
  const logs = [];

  await run(fake, db, { plans: [PLANS[0]], log: (m) => logs.push(m) });

  const basic = db.rows[0];
  assert.notEqual(basic.stripeProductId, "prod_TEST_ONLY");
  assert.notEqual(basic.stripePriceId, "price_TEST_ONLY");
  assert.ok(fake.products.has(basic.stripeProductId));
  assert.ok(logs.some((message) => /test\/live mismatch/.test(message)));
  assert.equal(fake.calls.filter(([name]) => name === "prices.update").length, 0);
});

test("legacy plans are merged and unused unknown plans are removed", async () => {
  const subscriptions = [{ planId: 1 }, { planId: 1 }, { planId: 3 }];
  const fake = createFakeStripe();
  const db = createFakeDb(
    [
      { name: "Basic Plan", priceMonthly: 10, stripeProductId: "p", stripePriceId: "x", maxSharedLocations: 1, isDefault: false },
      { name: "Old Unused", priceMonthly: 5, stripeProductId: "p2", stripePriceId: "y", maxSharedLocations: 1, isDefault: false },
      { name: "Old Used", priceMonthly: 5, stripeProductId: "p3", stripePriceId: "z", maxSharedLocations: 1, isDefault: false },
    ],
    { subscriptions }
  );

  await run(fake, db);

  const names = db.rows.map((row) => row.name).sort();
  assert.deepEqual(names, ["Basic", "Old Used", "Pro"]);

  const basic = db.rows.find((row) => row.name === "Basic");
  assert.equal(subscriptions.filter((s) => s.planId === basic.id).length, 2);
});

// -------------------------------------------------------- safety checks

test("the key mode is read from the prefix only", () => {
  assert.equal(getStripeKeyMode("sk_live_abc"), "live");
  assert.equal(getStripeKeyMode("rk_live_abc"), "live");
  assert.equal(getStripeKeyMode("sk_test_abc"), "test");
  assert.equal(getStripeKeyMode(""), "unknown");
  assert.equal(getStripeKeyMode(undefined), "unknown");
  assert.equal(getStripeKeyMode("whatever"), "unknown");
});

test("a live key outside production is refused unless --allow-live is passed", () => {
  assert.throws(
    () => assertSafeToRun({ mode: "live", nodeEnv: "development", allowLive: false }),
    /Refusing to use a LIVE Stripe key/
  );
  assert.throws(
    () => assertSafeToRun({ mode: "live", nodeEnv: undefined, allowLive: false }),
    /Refusing/
  );

  assert.equal(assertSafeToRun({ mode: "live", nodeEnv: "development", allowLive: true }), "live");
  assert.equal(assertSafeToRun({ mode: "live", nodeEnv: "production", allowLive: false }), "live");
  assert.equal(assertSafeToRun({ mode: "test", nodeEnv: "development", allowLive: false }), "test");
});

test("an unrecognised or missing key is refused", () => {
  assert.throws(() => assertSafeToRun({ mode: "unknown", nodeEnv: "production", allowLive: true }), /STRIPE_SECRET_KEY/);
});

// ------------------------------------------- webhook vs archived prices

test("a subscriber on an old archived price keeps their plan when the webhook syncs", async () => {
  const UserSubscription = require("../models/UserSubscription");
  const SubscriptionPlan = require("../models/SubscriptionPlan");
  const webhook = require("../controllers/stripeWebhookController");

  const originals = {
    findOne: UserSubscription.findOne,
    planFindOne: SubscriptionPlan.findOne,
  };

  let saved = false;
  const row = {
    planId: 42,
    stripeCustomerId: "cus_1",
    status: "active",
    save: async () => {
      saved = true;
    },
  };

  UserSubscription.findOne = async () => row;
  // The old price is no longer referenced by any plan row, so the lookup finds nothing.
  SubscriptionPlan.findOne = async () => null;

  try {
    await webhook._private.syncSubscriptionFromStripe({
      id: "sub_1",
      customer: "cus_1",
      status: "active",
      current_period_start: 1700000000,
      current_period_end: 1702592000,
      items: { data: [{ price: { id: "price_OLD_ARCHIVED" } }] },
    });
  } finally {
    UserSubscription.findOne = originals.findOne;
    SubscriptionPlan.findOne = originals.planFindOne;
  }

  assert.equal(saved, true);
  assert.equal(row.planId, 42, "existing planId must be kept");
  assert.equal(row.status, "active");
});
