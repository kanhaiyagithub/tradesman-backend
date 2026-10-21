const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

const TradesType = sequelize.define(
  "TradesType",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },

    name: {
      type: DataTypes.STRING,
      allowNull: false
    },

    category: {
      type: DataTypes.STRING,
      allowNull: false
    },

    isActive: {
      type: DataTypes.BOOLEAN,
      defaultValue: true
    },

    // Regulated work: tradespeople in this trade must provide a licence (number, expiry, document)
    // and an admin must approve it before they are offered. Unlicensed trades need no licence.
    licenceRequired: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false
    },

    // What the app calls the licence, e.g. "Plumbing licence (QBCC)". Shown to tradespeople.
    licenceLabel: {
      type: DataTypes.STRING(120),
      allowNull: true
    }
  },
  {
    tableName: "trades_type", // ✅ EXACT DB TABLE NAME
    timestamps: true
  }
);

module.exports = TradesType;
