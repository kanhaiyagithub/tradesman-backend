// models/locationModel.js
const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");
const User = require("./User");

const TravelPlan = sequelize.define(
  "TravelPlan",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },

    tradesmanId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },

    currentLocation: {
      type: DataTypes.STRING,
      allowNull: true,
    },

    latitude: {
      type: DataTypes.DOUBLE,
      allowNull: true,
    },

    longitude: {
      type: DataTypes.DOUBLE,
      allowNull: true,
    },

    startLocation: {
      type: DataTypes.STRING,
      allowNull: false,
    },

    // ✅ ONLY datetime
    startDateTime: {
      type: DataTypes.DATE,
      allowNull: false,
    },

    destination: {
      type: DataTypes.STRING,
      allowNull: false,
    },

    destinationLatitude: {
      type: DataTypes.DOUBLE,
      allowNull: false,
    },

    destinationLongitude: {
      type: DataTypes.DOUBLE,
      allowNull: false,
    },

    destinationDateTime: {
      type: DataTypes.DATE,
      allowNull: false,
    },

    priceRange: {
      type: DataTypes.STRING,
      allowNull: true,
    },

    allowStops: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },

    stops: {
      type: DataTypes.JSON,
      allowNull: true,
      comment: "Each stop: { name, latitude, longitude, expectedDateTime }",
    },

    status: {
      type: DataTypes.ENUM("open", "closed", "cancelled"),
      defaultValue: "open",
    },
  },
  {
    tableName: "travelplans",
    timestamps: true,
  }
);

TravelPlan.belongsTo(User, { as: "tradesman", foreignKey: "tradesmanId" });
User.hasMany(TravelPlan, { as: "travelPlans", foreignKey: "tradesmanId" });

module.exports = TravelPlan;
