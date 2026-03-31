const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

const DeviceToken = sequelize.define(
  "DeviceToken",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    user_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    token: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },
  },
  {
    tableName: "device_tokens",
    timestamps: false, // Matches your existing table structure (only 'created_at')
  }
);

// Compatibility wrappers for existing code
const saveDeviceToken = async (userId, token) => {
  // Use upsert or findOne/update for standard Sequelize logic
  const [deviceToken, created] = await DeviceToken.findOrCreate({
    where: { token },
    defaults: { user_id: userId, token },
  });

  if (!created) {
    deviceToken.user_id = userId;
    await deviceToken.save();
  }
  return deviceToken;
};

const getTokensByUser = async (userId) => {
  return await DeviceToken.findAll({
    where: { user_id: userId },
    attributes: ["token"],
    raw: true,
  });
};

module.exports = {
  DeviceToken,
  saveDeviceToken,
  getTokensByUser,
};