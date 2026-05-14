const chatService = require('../services/chatService');

/**
 * Sends a normalized API response for chat endpoints.
 *
 * @param {import('express').Response} res - Express response object.
 * @param {number} statusCode - HTTP status code.
 * @param {boolean} success - Whether the request succeeded.
 * @param {string} message - Human-readable status message.
 * @param {object|null} [data=null] - Response payload.
 * @param {string|null} [error=null] - Optional error details.
 * @returns {import('express').Response} Express JSON response.
 */
const sendResponse = (
  res,
  statusCode,
  success,
  message,
  data = null,
  error = null,
) => res.status(statusCode).json({ success, message, data, error });

/**
 * Parses page/limit values shared by inbox and legacy history endpoints.
 *
 * @param {import('express').Request} req - Express request.
 * @param {number} [defaultLimit=20] - Fallback page size.
 * @returns {{ page: number, limit: number }} Normalized pagination values.
 */
const parsePagination = (req, defaultLimit = 20) => {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(
    Math.max(parseInt(req.query.limit, 10) || defaultLimit, 1),
    100,
  );

  return { page, limit };
};

/**
 * Extracts cursor-style history pagination without breaking existing clients.
 *
 * Accepted query aliases:
 * - beforeMessageId
 * - cursor
 *
 * @param {import('express').Request} req - Express request.
 * @returns {{ beforeMessageId: number|null }} Cursor settings.
 */
const parseConversationCursor = (req) => {
  const rawBeforeMessageId = req.query.beforeMessageId || req.query.cursor;
  const beforeMessageId = rawBeforeMessageId ? Number(rawBeforeMessageId) || null : null;

  return { beforeMessageId };
};

/**
 * Returns a paginated success response with optional extra metadata.
 *
 * Existing frontend consumers can keep using `meta.total/page/perPage/totalPages`,
 * while newer clients can read cursor metadata when present.
 *
 * @param {import('express').Response} res - Express response.
 * @param {string} message - Response message.
 * @param {Array} items - Returned items.
 * @param {number} total - Total item count.
 * @param {number} page - Current page.
 * @param {number} limit - Page size.
 * @param {object} [extraMeta={}] - Additional metadata fields.
 * @returns {import('express').Response} Express JSON response.
 */
const paginatedResponse = (res, message, items, total, page, limit, extraMeta = {}) =>
  sendResponse(res, 200, true, message, {
    meta: {
      total,
      page,
      perPage: limit,
      totalPages: Math.ceil(total / limit),
      ...extraMeta,
    },
    data: items,
  });

/**
 * Emits the saved message to the target user's socket connections.
 *
 * @param {object} payload - Serialized chat payload.
 * @returns {Promise<void>} Resolves after the emit attempt finishes.
 */
const emitMessageToSocketUsers = async (payload) => {
  try {
    const { emitToUser } = require('../socket');
    emitToUser(payload.receiverId, 'receive-message', payload);
  } catch (error) {
    console.warn('[CHAT SOCKET EMIT ERROR]', error.message);
  }
};

/**
 * Persists a new chat message through the shared chat service.
 *
 * @param {import('express').Request} req - Express request.
 * @param {import('express').Response} res - Express response.
 * @returns {Promise<import('express').Response>} API response.
 */
exports.sendMessage = async (req, res) => {
  try {
    const senderId = req.user?.id;
    const { receiverId, message } = req.body;

    if (!senderId) {
      return sendResponse(res, 401, false, 'Unauthorized');
    }

    const newMessage = await chatService.sendDirectMessage({
      senderId,
      receiverId,
      message,
    });

    await emitMessageToSocketUsers(newMessage);

    return sendResponse(res, 201, true, 'Message sent', newMessage);
  } catch (error) {
    console.error('[SEND MESSAGE ERROR]', error);

    const statusCode =
      error.message === 'Unauthorized sender'
        ? 401
        : error.message === 'Receiver not found' || error.message === 'Sender not found'
          ? 404
          : 400;

    return sendResponse(res, statusCode, false, error.message || 'Server error');
  }
};

/**
 * Reads direct-message history with backward-compatible page/limit support.
 *
 * Newer clients may also send `beforeMessageId` or `cursor` to use cursor-based
 * pagination for older history without changing the response shape.
 *
 * @param {import('express').Request} req - Express request.
 * @param {import('express').Response} res - Express response.
 * @returns {Promise<import('express').Response>} API response.
 */
exports.getConversation = async (req, res) => {
  try {
    const loggedUser = Number(req.user?.id);
    const otherUserId = Number(req.params.userId);

    if (!loggedUser) {
      return sendResponse(res, 401, false, 'Unauthorized');
    }

    if (!otherUserId) {
      return sendResponse(res, 400, false, 'Invalid userId');
    }

    const { page, limit } = parsePagination(req);
    const { beforeMessageId } = parseConversationCursor(req);
    const result = await chatService.getConversationMessages({
      loggedUserId: loggedUser,
      otherUserId,
      page,
      limit,
      beforeMessageId,
    });

    return paginatedResponse(
      res,
      'Conversation fetched',
      result.items,
      result.total,
      result.page,
      result.limit,
      {
        hasMore: result.hasMore,
        nextCursor: result.nextCursor,
        mode: result.mode,
      },
    );
  } catch (error) {
    console.error('[GET CONVERSATION ERROR]', error);
    return sendResponse(res, 500, false, 'Server error');
  }
};

/**
 * Reads the authenticated user's inbox from conversation summary tables.
 *
 * @param {import('express').Request} req - Express request.
 * @param {import('express').Response} res - Express response.
 * @returns {Promise<import('express').Response>} API response.
 */
exports.getChatList = async (req, res) => {
  try {
    const userId = Number(req.user?.id);

    if (!userId) {
      return sendResponse(res, 401, false, 'Unauthorized');
    }

    const { page, limit } = parsePagination(req);
    const result = await chatService.getChatList({ userId, page, limit });

    return paginatedResponse(
      res,
      'Chat list fetched',
      result.items,
      result.total,
      result.page,
      result.limit,
    );
  } catch (error) {
    console.error('[CHAT LIST ERROR]', error);
    return sendResponse(res, 500, false, 'Server error');
  }
};

/**
 * Marks all unread messages from the target user as read.
 *
 * @param {import('express').Request} req - Express request.
 * @param {import('express').Response} res - Express response.
 * @returns {Promise<import('express').Response>} API response.
 */
exports.markAsRead = async (req, res) => {
  try {
    const userId = Number(req.user?.id);
    const { conversationWith } = req.body;

    if (!userId) {
      return sendResponse(res, 401, false, 'Unauthorized');
    }

    if (!conversationWith) {
      return sendResponse(res, 400, false, 'conversationWith required');
    }

    const result = await chatService.markConversationRead({
      userId,
      conversationWith,
    });

    return sendResponse(res, 200, true, 'Messages marked as read', result);
  } catch (error) {
    console.error('[MARK AS READ ERROR]', error);
    return sendResponse(res, 500, false, 'Server error');
  }
};
