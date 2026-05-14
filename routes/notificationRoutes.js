const express = require("express");
const router = express.Router();
const { verifyToken } = require("../middlewares/authMiddleware");
const {
  getMyNotifications,
  getMyUnreadNotificationCount,
  markAllMyNotificationsAsRead,
  markMyNotificationAsRead,
  saveMyDeviceToken,
} = require("../controllers/notificationController");

/**
 * Save the authenticated user's Firebase device token.
 *
 * @route POST /api/notifications/save-token
 * @access Private
 */
router.post("/save-token", verifyToken, saveMyDeviceToken);

/**
 * Fetch the authenticated user's notification inbox.
 *
 * @route GET /api/notifications?limit=20&cursor=123&unreadOnly=false
 * @access Private
 */
router.get("/", verifyToken, getMyNotifications);

/**
 * Fetch unread notification count for badge UI.
 *
 * @route GET /api/notifications/unread-count
 * @access Private
 */
router.get("/unread-count", verifyToken, getMyUnreadNotificationCount);

/**
 * Mark every non-expired notification as read.
 *
 * @route PATCH /api/notifications/read-all
 * @access Private
 */
router.patch("/read-all", verifyToken, markAllMyNotificationsAsRead);

/**
 * Mark a single notification as read.
 *
 * @route PATCH /api/notifications/:id/read
 * @access Private
 */
router.patch("/:id(\\d+)/read", verifyToken, markMyNotificationAsRead);

module.exports = router;
