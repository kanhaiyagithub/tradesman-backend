const admin = require("../utils/firebase");
const {
  getTokensByUser,
  deleteDeviceTokens,
  normalizeDeviceToken,
} = require("../models/deviceTokenModel");

/**
 * Firebase error codes that mean a device token is permanently unusable and
 * should be removed from the database immediately.
 */
const INVALID_FCM_TOKEN_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
]);

/**
 * Converts arbitrary payload values into strings because FCM data fields only
 * support string values.
 *
 * @param {Record<string, unknown>} data - Raw push payload.
 * @returns {Record<string, string>} String-only push payload.
 */
const buildStringDataPayload = (data = {}) => {
  const stringData = {};

  Object.keys(data || {}).forEach((key) => {
    stringData[key] = String(data[key] ?? "");
  });

  return stringData;
};

/**
 * Builds the outbound FCM message for a single target token.
 *
 * @param {string} deviceToken - Firebase registration token.
 * @param {string} title - Notification title.
 * @param {string} body - Notification body.
 * @param {Record<string, string>} data - String-only data payload.
 * @returns {import('firebase-admin').messaging.Message} Firebase message.
 */
const buildPushMessage = (deviceToken, title, body, data) => ({
  token: deviceToken,
  notification: {
    title,
    body,
  },
  data: {
    ...data,
    click_action: "FLUTTER_NOTIFICATION_CLICK",
  },
  android: {
    priority: "high",
    notification: {
      channelId: "high_importance_channel",
      sound: "notification_sound",
    },
  },
  apns: {
    headers: {
      "apns-priority": "10",
    },
    payload: {
      aps: {
        sound: "default",
      },
    },
  },
});

/**
 * Sends a Firebase push notification to every known device for a user.
 *
 * This is intentionally delivery-only. Persistent notification creation lives
 * in notificationService so the database remains the source of truth.
 *
 * @param {number} userId - Target user ID.
 * @param {string} title - Notification title.
 * @param {string} body - Notification body.
 * @param {Record<string, unknown>} [data={}] - Additional push data.
 * @returns {Promise<{pushSuccess: boolean, reason: string|null, sentCount: number, failureCount: number, removedInvalidTokenCount: number}>}
 */
const sendPushToUser = async (userId, title, body, data = {}) => {
  try {
    console.log("[PUSH] Starting push notification", {
      userId,
      title,
      body,
      data,
      at: new Date().toISOString(),
    });

    const tokens = await getTokensByUser(userId);

    if (!tokens || !tokens.length) {
      console.log("[PUSH] No tokens found", { userId });

      return {
        pushSuccess: false,
        reason: "NO_TOKENS",
        sentCount: 0,
        failureCount: 0,
        removedInvalidTokenCount: 0,
      };
    }

    const registrationTokens = tokens
      .map((tokenRecord) => normalizeDeviceToken(tokenRecord.token))
      .filter(Boolean);

    if (!registrationTokens.length) {
      return {
        pushSuccess: false,
        reason: "NO_VALID_TOKENS",
        sentCount: 0,
        failureCount: 0,
        removedInvalidTokenCount: 0,
      };
    }

    const stringData = buildStringDataPayload(data);
    const invalidTokensToDelete = new Set();
    let successCount = 0;
    let failureCount = 0;

    for (const deviceToken of registrationTokens) {
      try {
        const message = buildPushMessage(deviceToken, title, body, stringData);
        const response = await admin.messaging().send(message);

        successCount += 1;

        console.log("[PUSH SUCCESS]", {
          userId,
          token: `${deviceToken.substring(0, 15)}...`,
          messageId: response,
        });
      } catch (error) {
        failureCount += 1;

        console.error("[PUSH FAILURE]", {
          userId,
          token: `${deviceToken.substring(0, 15)}...`,
          error: error.message,
          code: error.code,
        });

        if (INVALID_FCM_TOKEN_CODES.has(error.code)) {
          invalidTokensToDelete.add(deviceToken);
        }
      }
    }

    let removedInvalidTokenCount = 0;

    if (invalidTokensToDelete.size) {
      removedInvalidTokenCount = await deleteDeviceTokens([...invalidTokensToDelete]);
    }

    return {
      pushSuccess: successCount > 0,
      reason: successCount > 0 ? null : "ALL_PUSHES_FAILED",
      sentCount: successCount,
      failureCount,
      removedInvalidTokenCount,
    };
  } catch (error) {
    console.error("[PUSH ERROR] Push crashed", {
      userId,
      error: error.message,
      stack: error.stack,
      at: new Date().toISOString(),
    });

    return {
      pushSuccess: false,
      reason: error.message || "PUSH_SEND_FAILED",
      sentCount: 0,
      failureCount: 0,
      removedInvalidTokenCount: 0,
    };
  }
};

module.exports = {
  sendPushToUser,
};
