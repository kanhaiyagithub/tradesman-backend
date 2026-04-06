const admin = require("../utils/firebase");
const {
  getTokensByUser,
  saveDeviceToken,
} = require("../models/deviceTokenModel");

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
      tokensPreview: (tokens || []).map((t) =>
        t.token ? `${t.token.substring(0, 15)}...` : null,
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
      };
    }

    const registrationTokens = tokens
      .map((t) => t.token)
      .filter((token) => token && token.trim().length > 0);

    console.log("[PUSH] Valid tokens prepared", {
      userId,
      validTokenCount: registrationTokens.length,
    });

    if (!registrationTokens.length) {
      console.log("[PUSH] No valid tokens after filtering", {
        userId,
      });

      return {
        success: false,
        reason: "NO_VALID_TOKENS",
        sentCount: 0,
        failureCount: 0,
      };
    }

    const stringData = {};
    Object.keys(data).forEach((key) => {
      stringData[key] = String(data[key] ?? "");
    });

    let successCount = 0;
    let failureCount = 0;

    for (const deviceToken of registrationTokens) {
      try {
        const message = {
          token: deviceToken,

          notification: {
            title,
            body,
          },

          data: {
            ...stringData,
            click_action: "FLUTTER_NOTIFICATION_CLICK",
          },

          android: {
            priority: "high",
            notification: {
              channelId: "high_importance_channel",
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
        };

        const response = await admin.messaging().send(message);

        successCount++;

        console.log("[PUSH SUCCESS]", {
          userId,
          token: deviceToken.substring(0, 15) + "...",
          messageId: response,
        });
      } catch (err) {
        failureCount++;

        console.error("[PUSH FAILURE]", {
          userId,
          token: deviceToken.substring(0, 15) + "...",
          error: err.message,
          code: err.code,
        });
      }
    }

    return {
      success: successCount > 0,
      reason: successCount > 0 ? null : "ALL_PUSHES_FAILED",
      sentCount: successCount,
      failureCount,
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
    };
  }
};

const saveMyDeviceToken = async (req, res) => {
  try {
    const userId = req.user.id;
    const { token } = req.body;

    console.log("[TOKEN] Save request received", {
      userId,
      hasToken: !!token,
      tokenPreview: token ? `${token.substring(0, 15)}...` : null,
    });

    if (!token || !token.trim()) {
      console.log("[TOKEN] Token missing", { userId });

      return res.status(400).json({
        success: false,
        message: "Token is required",
      });
    }

    await saveDeviceToken(userId, token.trim());

    console.log("[TOKEN] Token saved successfully", {
      userId,
      tokenPreview: `${token.substring(0, 15)}...`,
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
