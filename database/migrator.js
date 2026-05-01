const path = require('path');
const { Umzug, SequelizeStorage } = require('umzug');
const sequelize = require('../config/db');

/**
 * Creates the application's migration runner.
 *
 * Why this exists:
 * - keeps migration wiring in one place
 * - allows CLI scripts and tests to share the same Umzug instance
 * - replaces `sequelize.sync()` with explicit, reviewable schema changes
 *
 * Important:
 * - use a relative glob plus `cwd` so migration discovery works reliably
 *   on Windows and Linux
 *
 * @returns {import('umzug').Umzug} Configured Umzug instance.
 */
const createMigrator = () =>
  new Umzug({
    migrations: {
      glob: ['migrations/*.js', { cwd: path.join(__dirname, '..') }],
      resolve: ({ name, path: migrationPath, context }) => {
        // eslint-disable-next-line global-require, import/no-dynamic-require
        const migration = require(migrationPath);

        return {
          name,
          up: async () => migration.up({ context, sequelize }),
          down: async () => migration.down({ context, sequelize }),
        };
      },
    },
    context: sequelize.getQueryInterface(),
    storage: new SequelizeStorage({
      sequelize,
      modelName: 'SequelizeMeta',
      tableName: 'SequelizeMeta',
    }),
    logger: console,
  });

module.exports = {
  createMigrator,
};