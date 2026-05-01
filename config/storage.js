const path = require('path');

/**
 * Central storage configuration.
 *
 * Phase 1B keeps the app on local storage but introduces a provider-based
 * abstraction so controllers no longer need to know where files are stored.
 */
const storageConfig = {
  driver: process.env.STORAGE_DRIVER || 'local',
  local: {
    /**
     * Absolute root directory where local uploads are persisted.
     */
    rootDir: path.join(
      __dirname,
      '..',
      process.env.LOCAL_UPLOAD_ROOT || 'uploads'
    ),

    /**
     * Public base path exposed by Express for locally stored media.
     */
    publicBasePath: process.env.LOCAL_UPLOAD_PUBLIC_BASE || '/uploads',
  },
};

module.exports = storageConfig;
