const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

/**
 * Persistent, user-facing notification inbox entry.
 *
 * FCM only delivers a push message; it does not provide a reliable history for
 * the frontend. This table is the source of truth for the notification list.
 */
const Notification = sequelize.define(
  "Notification",
  {
    id: {
      type: DataTypes.BIGINT,
      primaryKey: true,
      autoIncrement: true,
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    title: {
      type: DataTypes.STRING(160),
      allowNull: false,
    },
    body: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    type: {
      type: DataTypes.STRING(60),
      allowNull: false,
      defaultValue: "general",
    },
    data: {
      type: DataTypes.JSON,
      allowNull: true,
    },
    isRead: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    readAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    deliveryStatus: {
      type: DataTypes.ENUM("pending", "sent", "failed", "skipped"),
      allowNull: false,
      defaultValue: "pending",
    },
    deliveryError: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    sentAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    expiresAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
  },
  {
    tableName: "notifications",
    timestamps: true,
    indexes: [
      { fields: ["userId", "createdAt"] },
      { fields: ["userId", "isRead", "createdAt"] },
      { fields: ["expiresAt"] },
    ],
  },
);

module.exports = Notification;
