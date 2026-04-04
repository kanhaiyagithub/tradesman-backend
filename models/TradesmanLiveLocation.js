const sequelize = require("../config/db");
const { DataTypes } = require("sequelize");

const TradesmanLiveLocation = sequelize.define(
  "TradesmanLiveLocation",
  {
    tradesmanId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      unique: true,
    },
    travelPlanId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    latitude: {
      type: DataTypes.DECIMAL(10, 7),
      allowNull: false,
    },
    longitude: {
      type: DataTypes.DECIMAL(10, 7),
      allowNull: false,
    },
  },
  {
    tableName: "tradesman_live_locations",
    timestamps: true,
  }
);

module.exports = TradesmanLiveLocation;