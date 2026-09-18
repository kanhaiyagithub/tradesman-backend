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
  },
  {
    tableName: "stripe_webhook_events",
    timestamps: true,
  }
);

module.exports = StripeWebhookEvent;
