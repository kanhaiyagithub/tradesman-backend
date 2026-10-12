const { DataTypes } = require("sequelize");

const tableExists = async (queryInterface, tableName) => {
  const tables = await queryInterface.showAllTables();
  return tables.some((entry) => {
    const name = typeof entry === "string" ? entry : entry.tableName || entry.table_name;
    return String(name).toLowerCase() === tableName.toLowerCase();
  });
};

const timestamps = () => ({
  createdAt: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW,
  },
  updatedAt: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW,
  },
});

module.exports = {
  up: async ({ context: queryInterface }) => {
    if (!(await tableExists(queryInterface, "meta_conversion_events"))) {
      await queryInterface.createTable("meta_conversion_events", {
        id: {
          type: DataTypes.INTEGER,
          primaryKey: true,
          autoIncrement: true,
          allowNull: false,
        },
        eventId: {
          type: DataTypes.STRING(191),
          allowNull: false,
          unique: true,
        },
        eventName: {
          type: DataTypes.STRING(80),
          allowNull: false,
        },
        userId: {
          type: DataTypes.INTEGER,
          allowNull: true,
        },
        status: {
          type: DataTypes.ENUM("pending", "sent", "failed", "skipped"),
          allowNull: false,
          defaultValue: "pending",
        },
        attempts: {
          type: DataTypes.INTEGER,
          allowNull: false,
          defaultValue: 0,
        },
        isTest: {
          type: DataTypes.BOOLEAN,
          allowNull: false,
          defaultValue: false,
        },
        payload: {
          type: DataTypes.JSON,
          allowNull: true,
        },
        lastError: {
          type: DataTypes.TEXT,
          allowNull: true,
        },
        fbtraceId: {
          type: DataTypes.STRING,
          allowNull: true,
        },
        sentAt: {
          type: DataTypes.DATE,
          allowNull: true,
        },
        ...timestamps(),
      });

      await queryInterface.addIndex("meta_conversion_events", ["status", "createdAt"], {
        name: "idx_meta_conversion_events_status_created",
      });
      await queryInterface.addIndex("meta_conversion_events", ["userId"], {
        name: "idx_meta_conversion_events_user",
      });
    }

    if (!(await tableExists(queryInterface, "meta_user_attributions"))) {
      await queryInterface.createTable("meta_user_attributions", {
        id: {
          type: DataTypes.INTEGER,
          primaryKey: true,
          autoIncrement: true,
          allowNull: false,
        },
        userId: {
          type: DataTypes.INTEGER,
          allowNull: false,
          unique: true,
        },
        platform: { type: DataTypes.STRING(16), allowNull: true },
        advertisingId: { type: DataTypes.STRING(64), allowNull: true },
        anonId: { type: DataTypes.STRING(128), allowNull: true },
        advertiserTrackingEnabled: { type: DataTypes.BOOLEAN, allowNull: true },
        applicationTrackingEnabled: { type: DataTypes.BOOLEAN, allowNull: true },
        appPackage: { type: DataTypes.STRING(150), allowNull: true },
        appVersionCode: { type: DataTypes.STRING(32), allowNull: true },
        appVersionName: { type: DataTypes.STRING(64), allowNull: true },
        osVersion: { type: DataTypes.STRING(32), allowNull: true },
        deviceModel: { type: DataTypes.STRING(100), allowNull: true },
        locale: { type: DataTypes.STRING(32), allowNull: true },
        timezoneAbbr: { type: DataTypes.STRING(16), allowNull: true },
        timezoneName: { type: DataTypes.STRING(64), allowNull: true },
        carrier: { type: DataTypes.STRING(100), allowNull: true },
        screenWidth: { type: DataTypes.INTEGER, allowNull: true },
        screenHeight: { type: DataTypes.INTEGER, allowNull: true },
        screenDensity: { type: DataTypes.FLOAT, allowNull: true },
        cpuCores: { type: DataTypes.INTEGER, allowNull: true },
        totalStorageGb: { type: DataTypes.FLOAT, allowNull: true },
        freeStorageGb: { type: DataTypes.FLOAT, allowNull: true },
        lastIp: { type: DataTypes.STRING(64), allowNull: true },
        lastUserAgent: { type: DataTypes.STRING(512), allowNull: true },
        ...timestamps(),
      });
    }
  },

  down: async ({ context: queryInterface }) => {
    if (await tableExists(queryInterface, "meta_user_attributions")) {
      await queryInterface.dropTable("meta_user_attributions");
    }

    if (await tableExists(queryInterface, "meta_conversion_events")) {
      await queryInterface.dropTable("meta_conversion_events");
    }
  },
};
