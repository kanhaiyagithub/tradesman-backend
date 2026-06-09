const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

const EmailNotificationLog = sequelize.define(
  "EmailNotificationLog",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },

    type: {
      type: DataTypes.STRING(80),
      allowNull: false,
    },

    travelPlanId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },

    clientTradeAlertId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },

    matchId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },

    clientId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },

    tradesmanId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },

    recipientUserId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },

    recipientEmail: {
      type: DataTypes.STRING,
      allowNull: false,
    },

    status: {
      type: DataTypes.ENUM("sent", "failed", "skipped"),
      allowNull: false,
      defaultValue: "sent",
    },

    errorMessage: {
      type: DataTypes.TEXT,
      allowNull: true,
    },

    sentAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    tableName: "email_notification_logs",
    timestamps: true,
    indexes: [
      { fields: ["type"] },
      { fields: ["travelPlanId"] },
      { fields: ["clientTradeAlertId"] },
      { fields: ["matchId"] },
      { fields: ["recipientUserId"] },
      {
        name: "uq_email_notification_logs_once",
        unique: true,
        fields: ["type", "travelPlanId", "clientTradeAlertId", "recipientUserId"],
      },
    ],
  },
);

module.exports = EmailNotificationLog;
