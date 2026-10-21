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
      autoIncrement: true,
    },

    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: "Users",
        key: "id",
      },
      onDelete: "CASCADE",
    },

    /* ================= BASIC INFO ================= */

    tradeType: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    tradeTypeId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },

    businessName: {
      type: DataTypes.STRING,
      allowNull: true,
    },

    shortBio: {
      type: DataTypes.TEXT,
      allowNull: true,
    },

    /* ================= AVAILABILITY ================= */

    startDate: {
      type: DataTypes.DATE,
      allowNull: true,
    },

    endDate: {
      type: DataTypes.DATE,
      allowNull: true,
    },

    /* ================= LOCATION (GPS) ================= */

    currentLocation: {
      type: DataTypes.STRING, // format: "lat,lng"
      allowNull: true,
    },

    /* ================= LICENSE & PORTFOLIO ================= */

    licenseNumber: {
      type: DataTypes.STRING,
      allowNull: true,
    },

    licenseExpiry: {
      type: DataTypes.DATE,
      allowNull: true,
    },

    licenseDocument: {
      type: DataTypes.STRING, // filename or path
      allowNull: true,
    },

    portfolioPhotos: {
      type: DataTypes.JSON,
      allowNull: true,
      // On MySQL/MariaDB setups where JSON is stored as text the driver hands back a string, which every
      // "is it a list?" check then treats as empty (the app showed no work photos). Always return a list.
      get() {
        const value = this.getDataValue("portfolioPhotos");
        if (typeof value !== "string") return value;
        try {
          const parsed = JSON.parse(value);
          return Array.isArray(parsed) ? parsed : [];
        } catch {
          return [];
        }
      },
    },

    portfolioDescription: {
      type: DataTypes.TEXT,
      allowNull: true,
    },

    /* ================= APPROVAL ================= */

    isApproved: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },

    approvedBy: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: "admin user id who approved",
    },

    approvedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },

    rejectionReason: {
      type: DataTypes.TEXT,
      allowNull: true,
    },

    verificationStatus: {
      type: DataTypes.ENUM("pending", "approved", "rejected", "resubmitted"),
      allowNull: false,
      defaultValue: "pending",
    },

    submittedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },

    resubmittedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },

    // True only when an admin approved the licence of a licence-required trade. Unlicensed tradespeople
    // can be approved (listed) without it. Always change it through services/verificationStateService.js.
    licenceVerified: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
  },
  {
    tableName: "TradesmanDetails",
    timestamps: true,
    indexes: [
      { fields: ["userId"] },
      { fields: ["tradeTypeId"] },
      { fields: ["isApproved"] },
    ],
  },
);

/* ================= RELATIONS ================= */

User.hasOne(TradesmanDetails, {
  foreignKey: "userId",
  as: "TradesmanDetail",
});

TradesmanDetails.belongsTo(User, {
  foreignKey: "userId",
  as: "user",
});

module.exports = TradesmanDetails;
