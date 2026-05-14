const { Op } = require("sequelize");
const Notification = require("../models/notificationModel");
const { sendPushToUser } = require("./pushNotificationService");

const DEFAULT_RETENTION_DAYS = Number(process.env.NOTIFICATION_RETENTION_DAYS || 10);
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * Notification types that should only be delivered as Firebase push messages.
 *
 * These events already have their own source-of-truth tables, such as chat
 * messages and conversation unread counts, so duplicating them in the generic
 * notification inbox would create noisy and stale data.
 */
const PUSH_ONLY_NOTIFICATION_TYPES = new Set([
  "CHAT",
  "CHAT_MESSAGE",
  "TYPING",
  "CALL_RINGING",
]);

/**
 * Checks whether a notification type should skip inbox persistence.
 *
 * @param {string|null|undefined} type - Raw notification type.
 * @returns {boolean} True when the type should be push-only.
 */
const isPushOnlyNotificationType = (type) =>
  PUSH_ONLY_NOTIFICATION_TYPES.has(String(type || "").toUpperCase());

/**
 * Adds days to a date without mutating the input date.
 *
 * @param {Date} date - Base date.
 * @param {number} days - Number of days to add.
 * @returns {Date} New date instance.
 */
const addDays = (date, days) => {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
};

/**
 * Keeps notification metadata JSON-safe and object-shaped.
 *
 * @param {unknown} data - Raw notification metadata.
 * @returns {Record<string, unknown>|null} Safe metadata object.
 */
const normalizeNotificationData = (data) => {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return null;
  }

  return data;
};

/**
 * Converts a Notification model instance to the API response shape.
 *
 * @param {import('sequelize').Model} notification - Notification row.
 * @returns {object} API-safe notification object.
 */
const serializeNotification = (notification) => ({
  id: Number(notification.id),
  userId: notification.userId,
  title: notification.title,
  body: notification.body,
  type: notification.type,
  data: notification.data || {},
  isRead: notification.isRead,
  readAt: notification.readAt,
  deliveryStatus: notification.deliveryStatus,
  sentAt: notification.sentAt,
  expiresAt: notification.expiresAt,
  createdAt: notification.createdAt,
});

/**
 * Creates a persistent notification row for the user's in-app inbox.
 *
 * @param {object} params - Notification creation parameters.
 * @param {number} params.userId - Target user ID.
 * @param {string} params.title - Notification title.
 * @param {string} params.body - Notification body.
 * @param {string} [params.type="general"] - Domain notification type.
 * @param {Record<string, unknown>} [params.data] - Extra metadata for routing.
 * @returns {Promise<import('sequelize').Model>} Created notification row.
 */
const createNotification = async ({ userId, title, body, type = "general", data = {} }) => {
  if (!userId) {
    throw new Error("userId is required to create a notification.");
  }

  if (!title || !body) {
    throw new Error("title and body are required to create a notification.");
  }

  const now = new Date();

  return Notification.create({
    userId,
    title,
    body,
    type,
    data: normalizeNotificationData(data),
    expiresAt: addDays(now, DEFAULT_RETENTION_DAYS),
  });
};

/**
 * Creates an in-app notification first, then attempts FCM delivery.
 *
 * Returning `success: true` means the user-facing notification was stored. Push
 * delivery details are returned separately because FCM is only one delivery
 * channel and may fail when the user has no registered device token.
 *
 * @param {number} userId - Target user ID.
 * @param {string} title - Notification title.
 * @param {string} body - Notification body.
 * @param {Record<string, unknown>} [data={}] - Notification metadata.
 * @returns {Promise<object>} Notification and push delivery result.
 */
const createAndSendNotification = async (userId, title, body, data = {}) => {
  const notificationType = data.type || "general";

  if (isPushOnlyNotificationType(notificationType)) {
    const pushResult = await sendPushToUser(userId, title, body, data);

    return {
      // Backwards-compatible field used by existing services.
      success: true,
      reason: null,

      // Push-only events, such as chat messages, are not stored in the inbox.
      notificationStored: false,
      notificationId: null,
      pushSuccess: pushResult.pushSuccess,
      pushReason: pushResult.reason,
      sentCount: pushResult.sentCount,
      failureCount: pushResult.failureCount,
      removedInvalidTokenCount: pushResult.removedInvalidTokenCount,
    };
  }

  const notification = await createNotification({
    userId,
    title,
    body,
    type: notificationType,
    data,
  });

  const pushResult = await sendPushToUser(userId, title, body, {
    ...data,
    notificationId: notification.id,
  });

  const deliveryStatus = pushResult.pushSuccess
    ? "sent"
    : pushResult.reason === "NO_TOKENS" || pushResult.reason === "NO_VALID_TOKENS"
      ? "skipped"
      : "failed";

  await notification.update({
    deliveryStatus,
    deliveryError: pushResult.pushSuccess ? null : String(pushResult.reason || "PUSH_FAILED").slice(0, 255),
    sentAt: pushResult.pushSuccess ? new Date() : null,
  });

  return {
    // Backwards-compatible field used by existing services.
    success: true,
    reason: null,

    // Explicit fields for new code.
    notificationStored: true,
    notificationId: Number(notification.id),
    pushSuccess: pushResult.pushSuccess,
    pushReason: pushResult.reason,
    sentCount: pushResult.sentCount,
    failureCount: pushResult.failureCount,
    removedInvalidTokenCount: pushResult.removedInvalidTokenCount,
  };
};

/**
 * Returns non-expired notifications for a user using cursor pagination.
 *
 * @param {object} params - Query parameters.
 * @param {number} params.userId - Authenticated user ID.
 * @param {number|string} [params.limit] - Page size.
 * @param {number|string|null} [params.cursor] - Last seen notification ID.
 * @param {boolean} [params.unreadOnly=false] - Whether to return unread rows only.
 * @returns {Promise<{items: object[], meta: object}>} Paginated result.
 */
const getUserNotifications = async ({ userId, limit = DEFAULT_LIMIT, cursor = null, unreadOnly = false }) => {
  const safeLimit = Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const cursorId = cursor ? Number(cursor) : null;

  const where = {
    userId,
    expiresAt: { [Op.gt]: new Date() },
  };

  if (cursorId) {
    where.id = { [Op.lt]: cursorId };
  }

  if (unreadOnly) {
    where.isRead = false;
  }

  const rows = await Notification.findAll({
    where,
    order: [["id", "DESC"]],
    limit: safeLimit + 1,
  });

  const hasMore = rows.length > safeLimit;
  const pageRows = hasMore ? rows.slice(0, safeLimit) : rows;

  return {
    items: pageRows.map(serializeNotification),
    meta: {
      limit: safeLimit,
      hasMore,
      nextCursor: hasMore ? Number(pageRows[pageRows.length - 1].id) : null,
    },
  };
};

/**
 * Counts unread, non-expired notifications for a user.
 *
 * @param {number} userId - Authenticated user ID.
 * @returns {Promise<number>} Unread notification count.
 */
const getUnreadNotificationCount = async (userId) => {
  return Notification.count({
    where: {
      userId,
      isRead: false,
      expiresAt: { [Op.gt]: new Date() },
    },
  });
};

/**
 * Marks a single notification as read if it belongs to the user.
 *
 * @param {object} params - Read parameters.
 * @param {number} params.userId - Authenticated user ID.
 * @param {number|string} params.notificationId - Notification ID.
 * @returns {Promise<boolean>} True if a row was updated.
 */
const markNotificationAsRead = async ({ userId, notificationId }) => {
  const [updatedCount] = await Notification.update(
    {
      isRead: true,
      readAt: new Date(),
    },
    {
      where: {
        id: notificationId,
        userId,
        isRead: false,
        expiresAt: { [Op.gt]: new Date() },
      },
    },
  );

  return updatedCount > 0;
};

/**
 * Marks every non-expired notification for a user as read.
 *
 * @param {number} userId - Authenticated user ID.
 * @returns {Promise<number>} Number of rows updated.
 */
const markAllNotificationsAsRead = async (userId) => {
  const [updatedCount] = await Notification.update(
    {
      isRead: true,
      readAt: new Date(),
    },
    {
      where: {
        userId,
        isRead: false,
        expiresAt: { [Op.gt]: new Date() },
      },
    },
  );

  return updatedCount;
};

/**
 * Hard-deletes expired notifications.
 *
 * @returns {Promise<number>} Deleted row count.
 */
const deleteExpiredNotifications = async () => {
  return Notification.destroy({
    where: {
      expiresAt: { [Op.lte]: new Date() },
    },
  });
};

module.exports = {
  createAndSendNotification,
  createNotification,
  deleteExpiredNotifications,
  getUnreadNotificationCount,
  getUserNotifications,
  markAllNotificationsAsRead,
  markNotificationAsRead,
};
