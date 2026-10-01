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

module.exports = {
  up: async ({ context: queryInterface }) => {
    const tableName = "stripe_webhook_events";

    if (!(await tableExists(queryInterface, tableName))) {
      return;
    }

    if (!(await columnExists(queryInterface, tableName, "processingStartedAt"))) {
      await queryInterface.addColumn(tableName, "processingStartedAt", {
        type: DataTypes.DATE,
        allowNull: true,
      });
    }

    if (!(await columnExists(queryInterface, tableName, "status"))) {
      await queryInterface.addColumn(tableName, "status", {
        type: DataTypes.ENUM("processing", "processed", "failed"),
        allowNull: false,
        defaultValue: "processing",
      });
    }
  },

  down: async ({ context: queryInterface, sequelize }) => {
    const tableName = "stripe_webhook_events";

    if (!(await tableExists(queryInterface, tableName))) {
      return;
    }

    if (await columnExists(queryInterface, tableName, "status")) {
      await queryInterface.removeColumn(tableName, "status");
    }

    if (await columnExists(queryInterface, tableName, "processingStartedAt")) {
      await queryInterface.removeColumn(tableName, "processingStartedAt");
    }

    if (sequelize.getDialect() === "postgres") {
      await sequelize.query('DROP TYPE IF EXISTS "enum_stripe_webhook_events_status";');
    }
  },
};
