const sequelize = require("../config/db");
const { DataTypes } = require("sequelize");

const LiveProximityNotification = sequelize.define(
  "LiveProximityNotification",
  {
    tradesmanId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    travelPlanId: {
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
    lastNotifiedAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
  },
  {
    tableName: "live_proximity_notifications",
    timestamps: true,
    indexes: [
      {
        name: "uniq_tp_client",
        unique: true,
        fields: ["travelPlanId", "clientId"],
      },
    ],
  }
);

module.exports = LiveProximityNotification;