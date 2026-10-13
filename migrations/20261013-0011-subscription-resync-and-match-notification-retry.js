const { DataTypes } = require("sequelize");

const tableExists = async (queryInterface, tableName) => {
  const tables = await queryInterface.showAllTables();
  return tables.some((entry) => {
    const name = typeof entry === "string" ? entry : entry.tableName || entry.table_name;
    return String(name).toLowerCase() === tableName.toLowerCase();
  });
};

const columnExists = async (queryInterface, tableName, columnName) => {
  if (!(await tableExists(queryInterface, tableName))) {
    return false;
  }

  const columns = await queryInterface.describeTable(tableName);
  return Object.prototype.hasOwnProperty.call(columns, columnName);
};

const addColumnIfMissing = async (queryInterface, tableName, columnName, definition) => {
  if (!(await tableExists(queryInterface, tableName))) return;
  if (await columnExists(queryInterface, tableName, columnName)) return;
  await queryInterface.addColumn(tableName, columnName, definition);
};

const removeColumnIfPresent = async (queryInterface, tableName, columnName) => {
  if (await columnExists(queryInterface, tableName, columnName)) {
    await queryInterface.removeColumn(tableName, columnName);
  }
};

const MATCHES = "travel_plan_alert_matches";
const SUBSCRIPTIONS = "user_subscriptions";
const MATCH_STATUS_INDEX = "idx_travel_plan_alert_matches_status_created";

/**
 * Adds:
 * - user_subscriptions.lastSyncedAt: when the row was last confirmed with Stripe
 *   (webhook or daily re-sync), so the re-sync job can find stale rows.
 * - travel_plan_alert_matches retry tracking columns and a `failed` status, so a
 *   match whose push could not be delivered can be retried with a limit.
 */
module.exports = {
  up: async ({ context: queryInterface }) => {
    await addColumnIfMissing(queryInterface, SUBSCRIPTIONS, "lastSyncedAt", {
      type: DataTypes.DATE,
      allowNull: true,
    });

    await addColumnIfMissing(queryInterface, MATCHES, "notificationAttempts", {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    });
    await addColumnIfMissing(queryInterface, MATCHES, "lastNotificationAttemptAt", {
      type: DataTypes.DATE,
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, MATCHES, "notificationId", {
      type: DataTypes.BIGINT,
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, MATCHES, "notificationError", {
      type: DataTypes.STRING(255),
      allowNull: true,
    });

    if (await tableExists(queryInterface, MATCHES)) {
      // Re-declaring the ENUM is idempotent: it simply adds `failed` if missing.
      await queryInterface.changeColumn(MATCHES, "status", {
        type: DataTypes.ENUM("pending", "notified", "contacted", "ignored", "failed"),
        allowNull: false,
        defaultValue: "pending",
      });

      const indexes = await queryInterface.showIndex(MATCHES);
      if (!indexes.some((index) => index.name === MATCH_STATUS_INDEX)) {
        await queryInterface.addIndex(MATCHES, ["status", "createdAt"], {
          name: MATCH_STATUS_INDEX,
        });
      }
    }
  },

  down: async ({ context: queryInterface }) => {
    if (await tableExists(queryInterface, MATCHES)) {
      const indexes = await queryInterface.showIndex(MATCHES);
      if (indexes.some((index) => index.name === MATCH_STATUS_INDEX)) {
        await queryInterface.removeIndex(MATCHES, MATCH_STATUS_INDEX);
      }

      await queryInterface.sequelize.query(
        `UPDATE ${MATCHES} SET status = 'pending' WHERE status = 'failed'`
      );
      await queryInterface.changeColumn(MATCHES, "status", {
        type: DataTypes.ENUM("pending", "notified", "contacted", "ignored"),
        allowNull: false,
        defaultValue: "pending",
      });
    }

    await removeColumnIfPresent(queryInterface, MATCHES, "notificationError");
    await removeColumnIfPresent(queryInterface, MATCHES, "notificationId");
    await removeColumnIfPresent(queryInterface, MATCHES, "lastNotificationAttemptAt");
    await removeColumnIfPresent(queryInterface, MATCHES, "notificationAttempts");
    await removeColumnIfPresent(queryInterface, SUBSCRIPTIONS, "lastSyncedAt");
  },
};
