// routes/chatRoutes.js
const express = require('express');
const router = express.Router();
const chatController = require('../controllers/chatController');
const { verifyToken } = require('../middlewares/authMiddleware');

/**
 * Send a message
 * POST /api/chat/send
 */
router.post(
  '/send',
  verifyToken,
  chatController.sendMessage
);

/**
 * Get conversation with a user
 * GET /api/chat/conversation/:userId
 */
router.get(
  '/conversation/:userId(\\d+)',
  verifyToken,
  chatController.getConversation
);

/**
 * Get chat list
 * GET /api/chat/list?page=1&limit=20
 */
router.get(
  '/list',
  verifyToken,
  chatController.getChatList
);

/**
 * Mark messages as read
 * PUT /api/chat/mark-read
 */
router.put(
  '/mark-read',
  verifyToken,
  chatController.markAsRead
);

module.exports = router;