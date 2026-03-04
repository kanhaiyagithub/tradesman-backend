const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

const User = require("./User");
const SubscriptionPlan = require("./SubscriptionPlan");

const UserSubscription = sequelize.define(
  "UserSubscription",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },

    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },

    planId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },

    // =====================
    // 🔥 STRIPE FIELDS
    // =====================

    stripeCustomerId: {
      type: DataTypes.STRING,
      allowNull: true,
    },

    stripeSubscriptionId: {
      type: DataTypes.STRING,
      allowNull: true,
      unique: true, // prevent duplicates
    },

    isEarlyAccess: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },

    hasLifetimeDiscount: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },

    trialEndsAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },

    // =====================
    // 🔥 Stripe lifecycle sync
    // =====================

    status: {
      type: DataTypes.ENUM(
        "trialing",
        "active",
        "incomplete",
        "past_due",
        "canceled",
        "unpaid"
      ),
      defaultValue: "incomplete",
    },

    currentPeriodStart: {
      type: DataTypes.DATE,
      allowNull: true,
    },

    currentPeriodEnd: {
      type: DataTypes.DATE,
      allowNull: true,
    },

    cancelAtPeriodEnd: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },

    startDate: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },

    endDate: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    tableName: "user_subscriptions",
    timestamps: true,
  }
);

/* =======================
   ✅ Associations
======================= */

UserSubscription.belongsTo(User, {
  foreignKey: "userId",
  as: "user",
});

User.hasMany(UserSubscription, {
  foreignKey: "userId",
  as: "subscriptions",
});

UserSubscription.belongsTo(SubscriptionPlan, {
  foreignKey: "planId",
  as: "plan",
});

SubscriptionPlan.hasMany(UserSubscription, {
  foreignKey: "planId",
  as: "userSubscriptions",
});

module.exports = UserSubscription;