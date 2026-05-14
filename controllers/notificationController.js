const {
  saveDeviceToken,
  normalizeDeviceToken,
} = require("../models/deviceTokenModel");
const {
  createAndSendNotification,
  getUnreadNotificationCount,
  getUserNotifications,
  markAllNotificationsAsRead,
  markNotificationAsRead,
} = require("../services/notificationService");

/**
 * Backwards-compatible notification sender used by existing domain services.
 *
 * The implementation now persists the notification for the in-app inbox first,
 * then attempts Firebase delivery as a best-effort side effect.
 *
 * @param {number} userId - Target user ID.
 * @param {string} title - Notification title.
 * @param {string} body - Notification body.
 * @param {Record<string, unknown>} [data={}] - Notification metadata.
 * @returns {Promise<object>} Stored notification and push delivery result.
 */
const sendPushNotification = async (userId, title, body, data = {}) => {
  try {
    return await createAndSendNotification(userId, title, body, data);
  } catch (error) {
    console.error("[NOTIFICATION ERROR] Failed to create/send notification", {
      userId,
      title,
      error: error.message,
      stack: error.stack,
    });

    return {
      success: false,
      reason: error.message || "NOTIFICATION_CREATE_FAILED",
      notificationStored: false,
      notificationId: null,
      pushSuccess: false,
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

    if (!normalizedToken) {
      return res.status(400).json({
        success: false,
        message: "Token is required",
      });
    }

    await saveDeviceToken(userId, normalizedToken);

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

/**
 * Lists authenticated user's non-expired notifications.
 *
 * Query params:
 * - limit: 1..100, defaults to 20
 * - cursor: notification id returned as nextCursor from previous page
 * - unreadOnly: true/false
 *
 * @param {import('express').Request} req - Express request.
 * @param {import('express').Response} res - Express response.
 * @returns {Promise<import('express').Response>} JSON result.
 */
const getMyNotifications = async (req, res) => {
  try {
    const userId = req.user.id;
    const unreadOnly = String(req.query.unreadOnly || "false").toLowerCase() === "true";

    const result = await getUserNotifications({
      userId,
      limit: req.query.limit,
      cursor: req.query.cursor,
      unreadOnly,
    });

    return res.json({
      success: true,
      message: "Notifications fetched successfully",
      data: result.items,
      meta: result.meta,
    });
  } catch (error) {
    console.error("[GET NOTIFICATIONS ERROR]", {
      error: error.message,
      stack: error.stack,
    });

    return res.status(500).json({
      success: false,
      message: "Failed to fetch notifications",
    });
  }
};

/**
 * Returns authenticated user's unread notification count.
 *
 * @param {import('express').Request} req - Express request.
 * @param {import('express').Response} res - Express response.
 * @returns {Promise<import('express').Response>} JSON result.
 */
const getMyUnreadNotificationCount = async (req, res) => {
  try {
    const unreadCount = await getUnreadNotificationCount(req.user.id);

    return res.json({
      success: true,
      message: "Unread notification count fetched successfully",
      data: { unreadCount },
    });
  } catch (error) {
    console.error("[GET UNREAD NOTIFICATION COUNT ERROR]", {
      error: error.message,
      stack: error.stack,
    });

    return res.status(500).json({
      success: false,
      message: "Failed to fetch unread notification count",
    });
  }
};

/**
 * Marks a single notification as read for the authenticated user.
 *
 * @param {import('express').Request} req - Express request.
 * @param {import('express').Response} res - Express response.
 * @returns {Promise<import('express').Response>} JSON result.
 */
const markMyNotificationAsRead = async (req, res) => {
  try {
    const notificationId = Number(req.params.id);

    if (!notificationId) {
      return res.status(400).json({
        success: false,
        message: "Invalid notification id",
      });
    }

    const updated = await markNotificationAsRead({
      userId: req.user.id,
      notificationId,
    });

    if (!updated) {
      return res.status(404).json({
        success: false,
        message: "Notification not found or already read",
      });
    }

    return res.json({
      success: true,
      message: "Notification marked as read",
    });
  } catch (error) {
    console.error("[MARK NOTIFICATION READ ERROR]", {
      error: error.message,
      stack: error.stack,
    });

    return res.status(500).json({
      success: false,
      message: "Failed to mark notification as read",
    });
  }
};

/**
 * Marks all non-expired notifications as read for the authenticated user.
 *
 * @param {import('express').Request} req - Express request.
 * @param {import('express').Response} res - Express response.
 * @returns {Promise<import('express').Response>} JSON result.
 */
const markAllMyNotificationsAsRead = async (req, res) => {
  try {
    const updatedCount = await markAllNotificationsAsRead(req.user.id);

    return res.json({
      success: true,
      message: "All notifications marked as read",
      data: { updatedCount },
    });
  } catch (error) {
    console.error("[MARK ALL NOTIFICATIONS READ ERROR]", {
      error: error.message,
      stack: error.stack,
    });

    return res.status(500).json({
      success: false,
      message: "Failed to mark notifications as read",
    });
  }
};

module.exports = {
  getMyNotifications,
  getMyUnreadNotificationCount,
  markAllMyNotificationsAsRead,
  markMyNotificationAsRead,
  saveMyDeviceToken,
  sendPushNotification,
};
