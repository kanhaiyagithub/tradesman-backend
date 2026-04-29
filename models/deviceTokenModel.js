const { DataTypes, Op } = require("sequelize");
const sequelize = require("../config/db");

/**
 * Stores Firebase Cloud Messaging device tokens for authenticated users.
 *
 * Notes:
 * - `token` stays globally unique so the same physical device token cannot be
 *   inserted more than once.
 * - Multiple rows per user are still allowed, which supports multiple devices
 *   per account.
 */
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
    timestamps: false,
  }
);

/**
 * Normalizes a raw device token before storage.
 *
 * @param {string} token - Raw token received from the client.
 * @returns {string|null} Trimmed token or null when empty/invalid.
 */
const normalizeDeviceToken = (token) => {
  if (typeof token !== "string") {
    return null;
  }

  const normalizedToken = token.trim();
  return normalizedToken.length ? normalizedToken : null;
};

/**
 * Creates or reassigns a device token to a user.
 *
 * This keeps token registration idempotent:
 * - if the exact token already exists for the same user, nothing new is added
 * - if the token exists for another user, ownership is reassigned
 * - if the token is new, a row is inserted
 *
 * @param {number} userId - Authenticated user ID.
 * @param {string} token - Firebase device token.
 * @returns {Promise<import('sequelize').Model>} Saved device token row.
 */
const saveDeviceToken = async (userId, token) => {
  const normalizedToken = normalizeDeviceToken(token);

  if (!userId || !normalizedToken) {
    throw new Error("A valid userId and token are required to save a device token.");
  }

  const [deviceToken, created] = await DeviceToken.findOrCreate({
    where: { token: normalizedToken },
    defaults: { user_id: userId, token: normalizedToken },
  });

  if (!created && deviceToken.user_id !== userId) {
    deviceToken.user_id = userId;
    await deviceToken.save();
  }

  return deviceToken;
};

/**
 * Returns all active device tokens for a user.
 *
 * @param {number} userId - User whose tokens should be loaded.
 * @returns {Promise<Array<{ token: string }>>} Array of token records.
 */
const getTokensByUser = async (userId) => {
  return DeviceToken.findAll({
    where: { user_id: userId },
    attributes: ["token"],
    raw: true,
    order: [["id", "DESC"]],
  });
};

/**
 * Deletes one or more device tokens from storage.
 *
 * @param {string|string[]} tokens - Token or list of tokens to remove.
 * @returns {Promise<number>} Number of deleted rows.
 */
const deleteDeviceTokens = async (tokens) => {
  const tokenList = Array.isArray(tokens) ? tokens : [tokens];
  const normalizedTokens = tokenList
    .map(normalizeDeviceToken)
    .filter(Boolean);

  if (!normalizedTokens.length) {
    return 0;
  }

  return DeviceToken.destroy({
    where: {
      token: {
        [Op.in]: normalizedTokens,
      },
    },
  });
};

module.exports = {
  DeviceToken,
  normalizeDeviceToken,
  saveDeviceToken,
  getTokensByUser,
  deleteDeviceTokens,
};
