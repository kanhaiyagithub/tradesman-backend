const { DataTypes } = require("sequelize");

const tableExists = async (queryInterface, tableName) => {
  const tables = await queryInterface.showAllTables();
  return tables.some((entry) => {
    const name = typeof entry === "string" ? entry : entry.tableName || entry.table_name;
    return String(name).toLowerCase() === tableName.toLowerCase();
  });
};

module.exports = {
  up: async ({ context: queryInterface }) => {
    if (await tableExists(queryInterface, "stripe_webhook_events")) {
      return;
    }

    await queryInterface.createTable("stripe_webhook_events", {
      eventId: {
        type: DataTypes.STRING,
        primaryKey: true,
        allowNull: false,
      },
      eventType: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      processedAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      processingStartedAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      status: {
        type: DataTypes.ENUM("processing", "processed", "failed"),
        allowNull: false,
        defaultValue: "processing",
      },
      createdAt: {
        type: DataTypes.DATE,
        allowNull: false,
      },
      updatedAt: {
        type: DataTypes.DATE,
        allowNull: false,
      },
    });
  },

  down: async ({ context: queryInterface }) => {
    if (await tableExists(queryInterface, "stripe_webhook_events")) {
      await queryInterface.dropTable("stripe_webhook_events");
    }
  },
};
