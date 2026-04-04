const admin = require("../utils/firebase");
const { getTokensByUser, saveDeviceToken } = require("../models/deviceTokenModel");

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
        t.token ? `${t.token.substring(0, 15)}...` : null
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

    const message = {
      notification: {
        title,
        body,
      },
      data: stringData,
      tokens: registrationTokens,
    };

    console.log("[PUSH] Sending to Firebase", {
      userId,
      tokenCount: registrationTokens.length,
      payload: {
        title,
        body,
        data: stringData,
      },
      at: new Date().toISOString(),
    });

    const response = await admin.messaging().sendEachForMulticast(message);

    console.log("[PUSH] Firebase response", {
      userId,
      successCount: response.successCount,
      failureCount: response.failureCount,
    });

    // 🔍 Log each token result
    response.responses.forEach((resp, index) => {
      const tokenPreview = `${registrationTokens[index].substring(0, 15)}...`;

      if (resp.success) {
        console.log("[PUSH SUCCESS]", {
          userId,
          token: tokenPreview,
          messageId: resp.messageId,
        });
      } else {
        console.error("[PUSH FAILURE]", {
          userId,
          token: tokenPreview,
          error: resp.error?.message,
          code: resp.error?.code,
        });
      }
    });

    return {
      success: response.successCount > 0,
      reason: response.successCount > 0 ? null : "ALL_PUSHES_FAILED",
      sentCount: response.successCount,
      failureCount: response.failureCount,
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