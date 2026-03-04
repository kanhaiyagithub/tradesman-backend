// models/SubscriptionPlan.js

const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

const SubscriptionPlan = sequelize.define(
  "SubscriptionPlan",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },

    name: {
      type: DataTypes.STRING,
      allowNull: false,
    },

    priceMonthly: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      defaultValue: 0.0,
    },

    // 🔥 Stripe Product (optional but recommended)
    stripeProductId: {
      type: DataTypes.STRING,
      allowNull: true,
    },

    // 🔥 Stripe Price ID (VERY IMPORTANT)
    stripePriceId: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },

    maxSharedLocations: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },

    isDefault: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
  },
  {
    tableName: "subscription_plans",
    timestamps: true,
  }
);

module.exports = SubscriptionPlan;