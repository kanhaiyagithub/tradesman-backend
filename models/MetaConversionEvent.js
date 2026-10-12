const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

/**
 * One row per Meta Conversions API event. The deterministic, unique `eventId`
 * makes webhook retries and double taps harmless.
 */
const MetaConversionEvent = sequelize.define(
  "MetaConversionEvent",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
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

    // Event as sent to Meta (hashed email/phone/user id only).
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
  },
  {
    tableName: "meta_conversion_events",
    timestamps: true,
    indexes: [
      { name: "idx_meta_conversion_events_status_created", fields: ["status", "createdAt"] },
      { name: "idx_meta_conversion_events_user", fields: ["userId"] },
    ],
  },
);

module.exports = MetaConversionEvent;
