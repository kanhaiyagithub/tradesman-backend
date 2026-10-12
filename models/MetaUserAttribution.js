const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

/**
 * Latest device / attribution info reported by the app, one row per user.
 * The Subscribe event fires from the Stripe webhook where there is no app
 * request, so this is where its identifiers come from.
 */
const MetaUserAttribution = sequelize.define(
  "MetaUserAttribution",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
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
  },
  {
    tableName: "meta_user_attributions",
    timestamps: true,
  },
);

module.exports = MetaUserAttribution;
