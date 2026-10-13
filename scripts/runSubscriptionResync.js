#!/usr/bin/env node
const dotenv = require('dotenv');
dotenv.config();

const sequelize = require('../config/db');
const { runSubscriptionResync } = require('../services/subscriptionResyncService');

/** Runs the Stripe subscription re-sync once (same logic as the daily job). */
const main = async () => {
  try {
    const result = await runSubscriptionResync();
    console.log('[SUBSCRIPTION_RESYNC] Done:', result);
  } finally {
    await sequelize.close();
  }
};

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('[SUBSCRIPTION_RESYNC] Unexpected error:', error.message);
    process.exit(1);
  });
