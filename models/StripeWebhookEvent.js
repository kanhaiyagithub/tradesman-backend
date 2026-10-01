const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

const StripeWebhookEvent = sequelize.define(
  "StripeWebhookEvent",
  {
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
  },
  {
    tableName: "stripe_webhook_events",
    timestamps: true,
  }
);

module.exports = StripeWebhookEvent;
