const { Sequelize } = require('sequelize');
require('dotenv').config();

/**
 * Shared Sequelize instance used across the application and migration runner.
 *
 * Notes:
 * - `sequelize.sync()` is no longer used at runtime.
 * - schema changes must go through explicit migrations.
 * - connection pooling is configured here so both API traffic and background
 *   scripts use the same database settings.
 */
const sequelize = new Sequelize(
  process.env.DB_NAME,
  process.env.DB_USER,
  process.env.DB_PASS,
  {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    dialect: 'mysql',
    logging: false,
    pool: {
      max: Number(process.env.DB_POOL_MAX || 10),
      min: Number(process.env.DB_POOL_MIN || 0),
      acquire: Number(process.env.DB_POOL_ACQUIRE_MS || 30000),
      idle: Number(process.env.DB_POOL_IDLE_MS || 10000),
    },
  }
);

/**
 * Verifies connectivity on startup without mutating schema.
 */
sequelize
  .authenticate()
  .then(() => console.log('✅ MySQL connected successfully'))
  .catch((err) => console.error('❌ Database connection error:', err));

module.exports = sequelize;
