#!/usr/bin/env node
const dotenv = require('dotenv');
dotenv.config();

const sequelize = require('../config/db');
const { runMatchNotificationRetry } = require('../services/matchNotificationRetryService');

/** Runs one pass of the pending-match push retry (same logic as the worker). */
const main = async () => {
  try {
    const result = await runMatchNotificationRetry();
    console.log('[MATCH_NOTIFICATION_RETRY] Done:', result);
  } finally {
    await sequelize.close();
  }
};

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('[MATCH_NOTIFICATION_RETRY] Unexpected error:', error.message);
    process.exit(1);
  });
