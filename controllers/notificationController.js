const admin = require("../utils/firebase");
const { getTokensByUser } = require("../models/deviceTokenModel");

const sendPushNotification = async (userId, title, body, data = {}) => {
  try {
    const tokens = await getTokensByUser(userId);

    if (!tokens || !tokens.length) {
      console.log(`[PUSH] No tokens found for user ${userId}`);
      return;
    }

    const registrationTokens = tokens.map((t) => t.token);

    // Filter out potential null/empty tokens
    const validTokens = registrationTokens.filter((token) => token && token.trim().length > 0);
    if (!validTokens.length) return;

    // Convert all data values to strings (FCM requirement)
    const stringData = {};
    Object.keys(data).forEach((key) => {
      stringData[key] = String(data[key]);
    });

    const message = {
      notification: {
        title,
        body,
      },
      data: stringData,
      tokens: validTokens,
    };

    const response = await admin.messaging().sendEachForMulticast(message);

    console.log(`[PUSH] Sent to user ${userId}. Success: ${response.successCount}, Failure: ${response.failureCount}`);
  } catch (error) {
    console.error(`[PUSH ERROR] User ${userId}:`, error.message);
  }
};

module.exports = {
  sendPushNotification,
};