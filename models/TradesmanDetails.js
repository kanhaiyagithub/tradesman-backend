// models/TradesmanDetails.js
const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");
const User = require("./User");

const TradesmanDetails = sequelize.define(
  "TradesmanDetails",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },

    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: "Users",
        key: "id"
      },
      onDelete: "CASCADE"
    },

    /* ================= BASIC INFO ================= */

    tradeType: {
      type: DataTypes.STRING,
      allowNull: false
    },

    businessName: {
      type: DataTypes.STRING,
      allowNull: true
    },

    shortBio: {
      type: DataTypes.TEXT,
      allowNull: true
    },

    /* ================= AVAILABILITY ================= */

    startDate: {
      type: DataTypes.DATE,
      allowNull: true
    },

    endDate: {
      type: DataTypes.DATE,
      allowNull: true
    },

    /* ================= LOCATION (GPS) ================= */

    currentLocation: {
      type: DataTypes.STRING, // format: "lat,lng"
      allowNull: true
    },

    /* ================= LICENSE & PORTFOLIO ================= */

    licenseNumber: {
      type: DataTypes.STRING,
      allowNull: true
    },

    licenseExpiry: {
      type: DataTypes.DATE,
      allowNull: true
    },

    licenseDocument: {
      type: DataTypes.STRING, // filename or path
      allowNull: true
    },

    portfolioPhotos: {
      type: DataTypes.JSON,
      allowNull: true
    },

    portfolioDescription: {
      type: DataTypes.TEXT,
      allowNull: true
    },

    /* ================= APPROVAL ================= */

    isApproved: {
      type: DataTypes.BOOLEAN,
      defaultValue: false
    },

    approvedBy: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: "admin user id who approved"
    },

    approvedAt: {
      type: DataTypes.DATE,
      allowNull: true
    },

    rejectionReason: {
      type: DataTypes.TEXT,
      allowNull: true
    }
  },
  {
    tableName: "TradesmanDetails",
    timestamps: true
  }
);

/* ================= RELATIONS ================= */

User.hasOne(TradesmanDetails, {
  foreignKey: "userId",
  as: "TradesmanDetail"
});

TradesmanDetails.belongsTo(User, {
  foreignKey: "userId",
  as: "user"
});

module.exports = TradesmanDetails;