#!/usr/bin/env node
const dotenv = require('dotenv');
dotenv.config();

const sequelize = require('../config/db');
const { runMessageCleanup } = require('../services/messageCleanupService');

/**
 * Deletes chat messages older than MESSAGE_RETENTION_DAYS (default 30).
 *   npm run chat:cleanup            delete
 *   npm run chat:cleanup -- --dry-run   only count
 */
const main = async () => {
  const dryRun = process.argv.includes('--dry-run');

  try {
    const result = await runMessageCleanup({ dryRun });
    console.log('[MESSAGE CLEANUP] Done:', result);
  } finally {
    await sequelize.close();
  }
};

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('[MESSAGE CLEANUP] Unexpected error:', error.message);
    process.exit(1);
  });
