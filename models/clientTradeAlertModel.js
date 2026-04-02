const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");
const User = require("./User");

const ClientTradeAlert = sequelize.define(
  "ClientTradeAlert",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },

    clientId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: "Users",
        key: "id",
      },
      onDelete: "CASCADE",
    },

    tradeType: {
      type: DataTypes.STRING,
      allowNull: true,
    },

    tradeTypeId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },

    locationName: {
      type: DataTypes.STRING,
      allowNull: false,
    },

    latitude: {
      type: DataTypes.DOUBLE,
      allowNull: false,
    },

    longitude: {
      type: DataTypes.DOUBLE,
      allowNull: false,
    },

    radiusKm: {
      type: DataTypes.DOUBLE,
      allowNull: false,
      defaultValue: 15,
    },

    isActive: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    },

    startDate: {
      type: DataTypes.DATE,
      allowNull: true,
    },

    endDate: {
      type: DataTypes.DATE,
      allowNull: true,
    },

    lastMatchedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    tableName: "client_trade_alerts",
    timestamps: true,
    indexes: [
      { fields: ["clientId"] },
      { fields: ["tradeTypeId"] },
      { fields: ["isActive"] },
    ],
  }
);

User.hasMany(ClientTradeAlert, {
  foreignKey: "clientId",
  as: "clientTradeAlerts",
});

ClientTradeAlert.belongsTo(User, {
  foreignKey: "clientId",
  as: "client",
});

module.exports = ClientTradeAlert;