const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

const TravelPlanAlertMatch = sequelize.define(
  "TravelPlanAlertMatch",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },

    travelPlanId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },

    tradesmanId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },

    clientId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },

    clientTradeAlertId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },

    matchedStopName: {
      type: DataTypes.STRING,
      allowNull: true,
    },

    matchedLatitude: {
      type: DataTypes.DOUBLE,
      allowNull: true,
    },

    matchedLongitude: {
      type: DataTypes.DOUBLE,
      allowNull: true,
    },

    matchedDistanceKm: {
      type: DataTypes.DOUBLE,
      allowNull: true,
    },

    estimatedArrivalDate: {
      type: DataTypes.DATE,
      allowNull: true,
    },

    notificationSent: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },

    notificationSentAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },

    // Push retry tracking (see matchNotificationRetryService).
    notificationAttempts: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },

    lastNotificationAttemptAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },

    // In-app notification row created for this match, reused on retries.
    notificationId: {
      type: DataTypes.BIGINT,
      allowNull: true,
    },

    notificationError: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },

    status: {
      type: DataTypes.ENUM("pending", "notified", "contacted", "ignored", "failed"),
      defaultValue: "pending",
    },
  },
  {
    tableName: "travel_plan_alert_matches",
    timestamps: true,
    indexes: [
      { fields: ["travelPlanId"] },
      { fields: ["clientId"] },
      { fields: ["clientTradeAlertId"] },
      { name: "idx_travel_plan_alert_matches_status_created", fields: ["status", "createdAt"] },
      {
        name: "uq_travel_plan_alert_matches_plan_alert",
        unique: true,
        fields: ["travelPlanId", "clientTradeAlertId"],
      },
    ],
  }
);

module.exports = TravelPlanAlertMatch;