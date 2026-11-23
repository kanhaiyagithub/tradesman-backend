// models/reviewModel.js
const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

const Review = sequelize.define("Review", {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },

  hireId: {
    type: DataTypes.INTEGER,
    allowNull: false
  },

  fromUserId: {
    type: DataTypes.INTEGER,
    allowNull: false
  },

  toUserId: {
    type: DataTypes.INTEGER,
    allowNull: false
  },

  rating: {
    type: DataTypes.INTEGER,
    allowNull: false,
    validate: { min: 1, max: 5 }
  },

  comment: {
    type: DataTypes.TEXT,
    validate: { len: [0, 1000] }
  },

  role: {
    type: DataTypes.ENUM("client", "tradesman"),
    allowNull: false
  }

}, {
  tableName: "reviews",
  timestamps: true,
  // Mirrors the database index from migration 0005: one review per hire per reviewer.
  indexes: [{ unique: true, name: "uq_reviews_hire_reviewer", fields: ["hireId", "fromUserId"] }]
});

module.exports = Review;
