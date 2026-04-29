const admin = require("../utils/firebase");
const {
  getTokensByUser,
  saveDeviceToken,
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

  Object.keys(data).forEach((key) => {
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
 * Sends a push notification to all currently known device tokens for a user.
 *
 * Dead Firebase tokens are removed automatically so they are not retried on
 * every future notification.
 *
 * @param {number} userId - Target user ID.
 * @param {string} title - Notification title.
 * @param {string} body - Notification body.
 * @param {Record<string, unknown>} [data={}] - Additional push data.
 * @returns {Promise<{success: boolean, reason: string | null, sentCount: number, failureCount: number, removedInvalidTokenCount?: number}>}
 */
const sendPushNotification = async (userId, title, body, data = {}) => {
  try {
    console.log("[PUSH] Starting push notification", {
      userId,
      title,
      body,
      data,
      at: new Date().toISOString(),
    });

    const tokens = await getTokensByUser(userId);

    console.log("[PUSH] Tokens fetched", {
      userId,
      tokenCount: tokens ? tokens.length : 0,
      tokensPreview: (tokens || []).map((tokenRecord) =>
        tokenRecord.token ? `${tokenRecord.token.substring(0, 15)}...` : null,
      ),
    });

    if (!tokens || !tokens.length) {
      console.log("[PUSH] No tokens found", {
        userId,
        at: new Date().toISOString(),
      });

      return {
        success: false,
        reason: "NO_TOKENS",
        sentCount: 0,
        failureCount: 0,
        removedInvalidTokenCount: 0,
      };
    }

    const registrationTokens = tokens
      .map((tokenRecord) => normalizeDeviceToken(tokenRecord.token))
      .filter(Boolean);

    console.log("[PUSH] Valid tokens prepared", {
      userId,
      validTokenCount: registrationTokens.length,
    });

    if (!registrationTokens.length) {
      console.log("[PUSH] No valid tokens after filtering", { userId });

      return {
        success: false,
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

        successCount++;

        console.log("[PUSH SUCCESS]", {
          userId,
          token: `${deviceToken.substring(0, 15)}...`,
          messageId: response,
        });
      } catch (error) {
        failureCount++;

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

      console.log("[PUSH CLEANUP] Removed invalid device tokens", {
        userId,
        removedInvalidTokenCount,
        removedTokensPreview: [...invalidTokensToDelete].map(
          (deviceToken) => `${deviceToken.substring(0, 15)}...`
        ),
      });
    }

    return {
      success: successCount > 0,
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
      success: false,
      reason: error.message || "PUSH_SEND_FAILED",
      sentCount: 0,
      failureCount: 0,
      removedInvalidTokenCount: 0,
    };
  }
};

/**
 * Saves the current device token for the authenticated user.
 *
 * @param {import('express').Request} req - Express request.
 * @param {import('express').Response} res - Express response.
 * @returns {Promise<import('express').Response>} JSON result.
 */
const saveMyDeviceToken = async (req, res) => {
  try {
    const userId = req.user.id;
    const normalizedToken = normalizeDeviceToken(req.body?.token);

    console.log("[TOKEN] Save request received", {
      userId,
      hasToken: !!normalizedToken,
      tokenPreview: normalizedToken
        ? `${normalizedToken.substring(0, 15)}...`
        : null,
    });

    if (!normalizedToken) {
      console.log("[TOKEN] Token missing", { userId });

      return res.status(400).json({
        success: false,
        message: "Token is required",
      });
    }

    await saveDeviceToken(userId, normalizedToken);

    console.log("[TOKEN] Token saved successfully", {
      userId,
      tokenPreview: `${normalizedToken.substring(0, 15)}...`,
      at: new Date().toISOString(),
    });

    return res.json({
      success: true,
      message: "Device token saved successfully",
    });
  } catch (error) {
    console.error("[TOKEN ERROR]", {
      error: error.message,
      stack: error.stack,
      at: new Date().toISOString(),
    });

    return res.status(500).json({
      success: false,
      message: "Failed to save device token",
    });
  }
};

module.exports = {
  sendPushNotification,
  saveMyDeviceToken,
};
