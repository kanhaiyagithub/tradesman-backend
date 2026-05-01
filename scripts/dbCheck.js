#!/usr/bin/env node
const sequelize = require('../config/db');

/**
 * Verifies that the backend can connect to MySQL without mutating schema.
 */
const main = async () => {
  try {
    await sequelize.authenticate();
    console.log('✅ Database connectivity check passed');
  } finally {
    await sequelize.close();
  }
};

main().catch((error) => {
  console.error('[DB CHECK ERROR]', {
    message: error.message,
    stack: error.stack,
  });
  process.exit(1);
});
