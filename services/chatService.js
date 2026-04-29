const { Op } = require('sequelize');
const sequelize = require('../config/db');
const Message = require('../models/messageModel');
const User = require('../models/User');
const Conversation = require('../models/conversationModel');
const ConversationParticipant = require('../models/conversationParticipantModel');
const {
  buildConversationKey,
  buildMessagePreview,
} = require('../utils/chatConversation');
const { sendPushNotification } = require('../controllers/notificationController');

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * Normalizes offset-based pagination input for endpoints that must remain
 * compatible with the existing frontend contract.
 *
 * @param {number|string} page - Requested page number.
 * @param {number|string} limit - Requested page size.
 * @returns {{ page: number, limit: number, offset: number }} Safe pagination values.
 */
const normalizeOffsetPagination = (page = 1, limit = DEFAULT_LIMIT) => {
  const safePage = Math.max(Number(page) || 1, 1);
  const safeLimit = Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);

  return {
    page: safePage,
    limit: safeLimit,
    offset: (safePage - 1) * safeLimit,
  };
};

/**
 * Normalizes cursor-based pagination for large message histories.
 *
 * When a cursor is not provided, the newest messages are returned.
 *
 * @param {number|string|null|undefined} beforeMessageId - Exclusive upper bound for older messages.
 * @param {number|string} limit - Requested page size.
 * @returns {{ beforeMessageId: number|null, limit: number }} Safe cursor pagination values.
 */
const normalizeCursorPagination = (beforeMessageId, limit = DEFAULT_LIMIT) => ({
  beforeMessageId: beforeMessageId ? Number(beforeMessageId) || null : null,
  limit: Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT),
});

/**
 * Builds a lightweight public user object for chat payloads.
 *
 * @param {import('sequelize').Model|null|undefined} user - Sequelize user model instance.
 * @returns {{ id?: number, name?: string, email?: string, role?: string, profileImage?: string } | null}
 */
const serializeChatUser = (user) => {
  if (!user) {
    return null;
  }

  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    profileImage: user.profileImage,
  };
};

/**
 * Maps a stored message row into the response shape expected by the frontend.
 *
 * @param {import('sequelize').Model} row - Stored message row.
 * @param {number} loggedUserId - Authenticated user id.
 * @param {Record<number, import('sequelize').Model>} userMap - Preloaded users keyed by id.
 * @returns {{
 *   id: number,
 *   senderId: number,
 *   receiverId: number,
 *   message: string,
 *   isRead: boolean,
 *   createdAt: Date,
 *   updatedAt: Date,
 *   conversationId: number|null,
 *   isMine: boolean,
 *   sender: object|null,
 *   receiver: object|null,
 * }} Serializable chat message.
 */
const serializeMessage = (row, loggedUserId, userMap) => ({
  id: row.id,
  senderId: row.senderId,
  receiverId: row.receiverId,
  message: row.message,
  isRead: row.isRead,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  conversationId: row.conversationId || null,
  isMine: row.senderId === loggedUserId,
  sender: serializeChatUser(userMap[row.senderId]),
  receiver: serializeChatUser(userMap[row.receiverId]),
});

/**
 * Loads both chat users in one query so messages can be enriched without
 * repeated lookups per row.
 *
 * @param {number[]} userIds - User ids to load.
 * @returns {Promise<Record<number, import('sequelize').Model>>} Users keyed by id.
 */
const getUserMapByIds = async (userIds) => {
  const uniqueUserIds = [...new Set(userIds.map(Number).filter(Boolean))];

  if (!uniqueUserIds.length) {
    return {};
  }

  const users = await User.findAll({
    where: { id: uniqueUserIds },
    attributes: ['id', 'name', 'email', 'role', 'profileImage'],
  });

  return Object.fromEntries(users.map((user) => [user.id, user]));
};

/**
 * Resolves the direct conversation summary row for two users.
 *
 * @param {number} userAId - First user id.
 * @param {number} userBId - Second user id.
 * @param {import('sequelize').Transaction} [transaction] - Optional transaction.
 * @returns {Promise<import('sequelize').Model|null>} Conversation row when present.
 */
const findDirectConversation = async (userAId, userBId, transaction) =>
  Conversation.findOne({
    where: {
      directKey: buildConversationKey(userAId, userBId),
    },
    transaction,
  });

/**
 * Builds a safe message filter for the migration window.
 *
 * Preferred behavior:
 * - Use `conversationId` whenever the summary row exists.
 * - Also include legacy rows that still only have `conversationKey`, so reads do
 *   not break during phased rollout or partial backfills.
 *
 * @param {{ conversationId?: number|null, directKey: string, beforeMessageId?: number|null }} params
 * @returns {object} Sequelize-compatible `where` clause.
 */
const buildConversationMessageWhere = ({
  conversationId = null,
  directKey,
  beforeMessageId = null,
}) => {
  const idConstraint = beforeMessageId
    ? {
        id: {
          [Op.lt]: beforeMessageId,
        },
      }
    : {};

  if (conversationId) {
    return {
      ...idConstraint,
      [Op.or]: [
        { conversationId },
        {
          conversationId: null,
          conversationKey: directKey,
        },
      ],
    };
  }

  return {
    ...idConstraint,
    conversationKey: directKey,
  };
};

/**
 * Ensures a direct conversation summary exists and both users have participant
 * rows. This is the single write-side entry point used by REST and sockets.
 *
 * @param {{ userAId: number, userBId: number, transaction?: import('sequelize').Transaction }} params
 * @returns {Promise<import('sequelize').Model>} Resolved conversation row.
 */
const getOrCreateConversation = async ({ userAId, userBId, transaction }) => {
  const directKey = buildConversationKey(userAId, userBId);
  const userOneId = Math.min(Number(userAId), Number(userBId));
  const userTwoId = Math.max(Number(userAId), Number(userBId));

  let conversation = await Conversation.findOne({
    where: { directKey },
    transaction,
    lock: transaction ? transaction.LOCK.UPDATE : undefined,
  });

  if (!conversation) {
    conversation = await Conversation.create(
      {
        directKey,
        userOneId,
        userTwoId,
      },
      { transaction }
    );
  }

  await ConversationParticipant.findOrCreate({
    where: {
      conversationId: conversation.id,
      userId: Number(userAId),
    },
    defaults: {
      conversationId: conversation.id,
      userId: Number(userAId),
      otherUserId: Number(userBId),
      unreadCount: 0,
    },
    transaction,
  });

  await ConversationParticipant.findOrCreate({
    where: {
      conversationId: conversation.id,
      userId: Number(userBId),
    },
    defaults: {
      conversationId: conversation.id,
      userId: Number(userBId),
      otherUserId: Number(userAId),
      unreadCount: 0,
    },
    transaction,
  });

  return conversation;
};

/**
 * Persists a new direct message, updates conversation summary data,
 * and triggers a push notification after the DB transaction succeeds.
 *
 * Important:
 * - Push is sent only after commit so users are never notified about
 *   a message that failed to save.
 * - This keeps REST and socket behavior aligned because both flows
 *   already call this shared service.
 *
 * @param {{ senderId: number|string, receiverId: number|string, message: string }} params
 * @returns {Promise<object>} Saved message in frontend-compatible format.
 */
const sendDirectMessage = async ({ senderId, receiverId, message }) => {
  const tx = await sequelize.transaction();

  try {
    const normalizedSenderId = Number(senderId);
    const normalizedReceiverId = Number(receiverId);
    const normalizedMessage = String(message || '').trim();

    if (!normalizedSenderId) {
      throw new Error('Unauthorized sender');
    }

    if (!normalizedReceiverId) {
      throw new Error('receiverId is required');
    }

    if (!normalizedMessage) {
      throw new Error('message is required');
    }

    if (normalizedSenderId === normalizedReceiverId) {
      throw new Error('You cannot message yourself');
    }

    const [sender, receiver] = await Promise.all([
      User.findByPk(normalizedSenderId, {
        transaction: tx,
        attributes: ['id', 'name', 'email', 'role', 'profileImage'],
      }),
      User.findByPk(normalizedReceiverId, {
        transaction: tx,
        attributes: ['id', 'name', 'email', 'role', 'profileImage'],
      }),
    ]);

    if (!sender) {
      throw new Error('Sender not found');
    }

    if (!receiver) {
      throw new Error('Receiver not found');
    }

    const conversation = await getOrCreateConversation({
      userAId: normalizedSenderId,
      userBId: normalizedReceiverId,
      transaction: tx,
    });

    const createdMessage = await Message.create(
      {
        conversationId: conversation.id,
        conversationKey: conversation.directKey,
        senderId: normalizedSenderId,
        receiverId: normalizedReceiverId,
        message: normalizedMessage,
        isRead: false,
      },
      { transaction: tx }
    );

    const now = createdMessage.createdAt || new Date();

    await conversation.update(
      {
        lastMessageId: createdMessage.id,
        lastMessageSenderId: normalizedSenderId,
        lastMessagePreview: buildMessagePreview(normalizedMessage),
        lastMessageAt: now,
      },
      { transaction: tx }
    );

    await ConversationParticipant.update(
      {
        unreadCount: 0,
        lastReadMessageId: createdMessage.id,
        lastReadAt: now,
      },
      {
        where: {
          conversationId: conversation.id,
          userId: normalizedSenderId,
        },
        transaction: tx,
      }
    );

    await ConversationParticipant.increment(
      { unreadCount: 1 },
      {
        where: {
          conversationId: conversation.id,
          userId: normalizedReceiverId,
        },
        transaction: tx,
      }
    );

    await tx.commit();

    const responsePayload = {
      id: createdMessage.id,
      senderId: createdMessage.senderId,
      receiverId: createdMessage.receiverId,
      message: createdMessage.message,
      isRead: createdMessage.isRead,
      createdAt: createdMessage.createdAt,
      updatedAt: createdMessage.updatedAt,
      conversationId: createdMessage.conversationId,
      conversationKey: createdMessage.conversationKey,
      sender: serializeChatUser(sender),
      receiver: serializeChatUser(receiver),
    };

    /**
     * Send push only after commit.
     * This prevents false notifications for rolled-back messages.
     */
    try {
      await sendPushNotification(
        normalizedReceiverId,
        sender.name || 'New Message',
        normalizedMessage.length > 120
          ? `${normalizedMessage.substring(0, 120)}...`
          : normalizedMessage,
        {
          type: 'CHAT_MESSAGE',
          senderId: normalizedSenderId,
          receiverId: normalizedReceiverId,
          messageId: createdMessage.id,
          conversationId: conversation.id,
        }
      );

      console.log('[CHAT PUSH TRIGGERED]', {
        senderId: normalizedSenderId,
        receiverId: normalizedReceiverId,
        messageId: createdMessage.id,
      });
    } catch (pushError) {
      console.error('[CHAT PUSH ERROR]', {
        senderId: normalizedSenderId,
        receiverId: normalizedReceiverId,
        messageId: createdMessage.id,
        error: pushError.message,
      });
    }

    return responsePayload;
  } catch (error) {
    await tx.rollback();
    throw error;
  }
};

/**
 * Reads conversation history using either offset pagination for legacy clients
 * or cursor pagination for large histories.
 *
 * Cursor mode is activated when `beforeMessageId` is provided. The existing
 * frontend can continue sending `page` and `limit` without any change.
 *
 * @param {{
 *   loggedUserId: number|string,
 *   otherUserId: number|string,
 *   page?: number|string,
 *   limit?: number|string,
 *   beforeMessageId?: number|string|null,
 * }} params
 * @returns {Promise<{
 *   items: object[],
 *   total: number,
 *   page: number,
 *   limit: number,
 *   hasMore: boolean,
 *   nextCursor: number|null,
 *   mode: 'offset' | 'cursor',
 * }>} Conversation payload.
 */
const getConversationMessages = async ({
  loggedUserId,
  otherUserId,
  page = 1,
  limit = DEFAULT_LIMIT,
  beforeMessageId = null,
}) => {
  const normalizedLoggedUserId = Number(loggedUserId);
  const normalizedOtherUserId = Number(otherUserId);
  const directKey = buildConversationKey(normalizedLoggedUserId, normalizedOtherUserId);
  const usingCursor = Boolean(beforeMessageId);
  const offsetPagination = normalizeOffsetPagination(page, limit);
  const cursorPagination = normalizeCursorPagination(beforeMessageId, limit);
  const conversation = await findDirectConversation(normalizedLoggedUserId, normalizedOtherUserId);

  const baseWhere = buildConversationMessageWhere({
    conversationId: conversation?.id || null,
    directKey,
  });

  let rows;
  let total;

  if (usingCursor) {
    rows = await Message.findAll({
      where: buildConversationMessageWhere({
        conversationId: conversation?.id || null,
        directKey,
        beforeMessageId: cursorPagination.beforeMessageId,
      }),
      order: [['id', 'DESC']],
      limit: cursorPagination.limit + 1,
    });

    total = await Message.count({ where: baseWhere });
  } else {
    const result = await Message.findAndCountAll({
      where: baseWhere,
      order: [['id', 'DESC']],
      limit: offsetPagination.limit,
      offset: offsetPagination.offset,
    });

    rows = result.rows;
    total = result.count;
  }

  const requestedLimit = usingCursor ? cursorPagination.limit : offsetPagination.limit;
  const hasMore = rows.length > requestedLimit;
  const trimmedRows = hasMore ? rows.slice(0, requestedLimit) : rows;
  const orderedRows = [...trimmedRows].reverse();

  const userMap = await getUserMapByIds([
    normalizedLoggedUserId,
    normalizedOtherUserId,
    ...orderedRows.flatMap((row) => [row.senderId, row.receiverId]),
  ]);

  return {
    items: orderedRows.map((row) => serializeMessage(row, normalizedLoggedUserId, userMap)),
    total,
    page: usingCursor ? 1 : offsetPagination.page,
    limit: requestedLimit,
    hasMore,
    nextCursor: hasMore ? trimmedRows[trimmedRows.length - 1]?.id || null : null,
    mode: usingCursor ? 'cursor' : 'offset',
  };
};

/**
 * Reads the chat inbox from conversation summary tables instead of rebuilding
 * it from the raw messages table on every request.
 *
 * @param {{ userId: number|string, page?: number|string, limit?: number|string }} params
 * @returns {Promise<{ items: object[], total: number, page: number, limit: number }>} Chat list payload.
 */
const getChatList = async ({ userId, page = 1, limit = DEFAULT_LIMIT }) => {
  const normalizedUserId = Number(userId);
  const { page: safePage, limit: safeLimit, offset } = normalizeOffsetPagination(page, limit);

  const { rows, count } = await ConversationParticipant.findAndCountAll({
    where: {
      userId: normalizedUserId,
    },
    include: [
      {
        model: Conversation,
        as: 'conversation',
        required: true,
      },
    ],
    order: [[{ model: Conversation, as: 'conversation' }, 'lastMessageAt', 'DESC']],
    limit: safeLimit,
    offset,
    distinct: true,
  });

  const userMap = await getUserMapByIds(rows.map((row) => row.otherUserId));

  const items = rows.map((row) => ({
    withUser: serializeChatUser(userMap[row.otherUserId]) || { id: row.otherUserId },
    unreadCount: row.unreadCount || 0,
    lastAt: row.conversation?.lastMessageAt || row.updatedAt,
    lastMessage: row.conversation?.lastMessagePreview || null,
    lastMessageId: row.conversation?.lastMessageId || null,
    lastMessageSenderId: row.conversation?.lastMessageSenderId || null,
  }));

  return {
    items,
    total: count,
    page: safePage,
    limit: safeLimit,
  };
};

/**
 * Marks a direct conversation as read for the authenticated user.
 *
 * Per-message read flags are still updated for frontend compatibility, while
 * the participant summary row remains the scalable source of truth.
 *
 * @param {{ userId: number|string, conversationWith: number|string }} params
 * @returns {Promise<{ updated: number, conversationId: number|null }>} Read update summary.
 */
const markConversationRead = async ({ userId, conversationWith }) => {
  const normalizedUserId = Number(userId);
  const normalizedOtherUserId = Number(conversationWith);
  const directKey = buildConversationKey(normalizedUserId, normalizedOtherUserId);
  const conversation = await findDirectConversation(normalizedUserId, normalizedOtherUserId);

  const [updated] = await Message.update(
    { isRead: true },
    {
      where: {
        senderId: normalizedOtherUserId,
        receiverId: normalizedUserId,
        isRead: false,
        ...buildConversationMessageWhere({
          conversationId: conversation?.id || null,
          directKey,
        }),
      },
    }
  );

  if (conversation) {
    await ConversationParticipant.update(
      {
        unreadCount: 0,
        lastReadMessageId: conversation.lastMessageId || null,
        lastReadAt: new Date(),
      },
      {
        where: {
          conversationId: conversation.id,
          userId: normalizedUserId,
        },
      }
    );
  }

  return {
    updated,
    conversationId: conversation?.id || null,
  };
};

module.exports = {
  buildConversationKey,
  sendDirectMessage,
  getConversationMessages,
  getChatList,
  markConversationRead,
};
