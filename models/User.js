const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

const User = sequelize.define(
  "User",
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

    email: {
      type: DataTypes.STRING,
      allowNull: false,
      // unique: true
    },

    mobile: {
      type: DataTypes.STRING
    },

    password: {
      type: DataTypes.STRING
    },

    role: {
      type: DataTypes.ENUM("tradesman", "client", "admin"),
      defaultValue: "client",
    },

    provider: {
      type: DataTypes.STRING,
      defaultValue: "manual"
    },

    googleId: {
      type: DataTypes.STRING
    },

    profileImage: {
      type: DataTypes.STRING
    },

    resetPasswordToken: {
      type: DataTypes.STRING,
      allowNull: true
    },

    resetPasswordExpires: {
      type: DataTypes.DATE,
      allowNull: true
    },
    isVerified: {
      type: DataTypes.BOOLEAN,
      defaultValue: false
    },

    // Test account made by an admin from the dashboard. Dummy users are kept out of real
    // statistics and never mix with real users (see migration 0017).
    isDummy: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false
    }

  },
  {
    timestamps: true,
    tableName: "Users",
  }
);

module.exports = User;
