const dotenv = require('dotenv');
dotenv.config();

const sequelize = require('../config/db');
const { getConfig, retryPendingEvents } = require('../services/metaConversionService');

/**
 * Re-sends failed (and stale pending) Meta Conversions API events.
 * Safe to run from cron, e.g. every 15 minutes.
 */
const main = async () => {
  if (!getConfig().enabled) {
    console.log('[META_RETRY] META_CAPI_ENABLED is not "true"; nothing to do.');
    return;
  }

  try {
    const summary = await retryPendingEvents();
    console.log('[META_RETRY] Done:', summary);
  } finally {
    await sequelize.close();
  }
};

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('[META_RETRY] Unexpected error:', error.message);
    process.exit(1);
  });
