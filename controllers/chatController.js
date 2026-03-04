// controllers/chatController.js
const { Op, Sequelize } = require('sequelize');
const Message = require('../models/messageModel');
const User = require('../models/User');

/* ================= HELPERS ================= */

const sendResponse = (res, statusCode, success, message, data = null, error = null) => {
  console.log('[RESPONSE]', { statusCode, success, message });
  return res.status(statusCode).json({ success, message, data, error });
};

const parsePagination = (req, defaultLimit = 20) => {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || defaultLimit, 1), 100);
  const offset = (page - 1) * limit;

  console.log('[PAGINATION]', { page, limit, offset });
  return { page, limit, offset };
};

const paginatedResponse = (res, message, items, total, page, limit) => {
  console.log('[PAGINATED RESPONSE]', { total, page, limit });
  return sendResponse(res, 200, true, message, {
    meta: {
      total,
      page,
      perPage: limit,
      totalPages: Math.ceil(total / limit)
    },
    data: items
  });
};

/* ================= SEND MESSAGE ================= */

exports.sendMessage = async (req, res) => {
  const t = await Message.sequelize.transaction();
  try {
    const senderId = req.user?.id;
    const { receiverId, message } = req.body;

    console.log('[SEND MESSAGE]', { senderId, receiverId, message });

    if (!senderId) return sendResponse(res, 401, false, 'Unauthorized');
    if (!receiverId || !message)
      return sendResponse(res, 400, false, 'receiverId and message required');

    const newMsg = await Message.create(
      {
        senderId,
        receiverId,
        message,
        isRead: false
      },
      { transaction: t }
    );

    await t.commit();

    console.log('[MESSAGE SAVED]', newMsg.id);

    /* SOCKET (SAFE) */
    try {
      const { getIO, getOnlineUsers } = require('../socket');
      const io = getIO();
      const onlineUsers = getOnlineUsers();
      const receiverSocket = onlineUsers.get(String(receiverId));

      if (receiverSocket) {
        io.to(receiverSocket).emit('receive-message', newMsg);
        console.log('[SOCKET] emitted to', receiverSocket);
      }
    } catch (e) {
      console.warn('[SOCKET ERROR]', e.message);
    }

    return sendResponse(res, 201, true, 'Message sent', newMsg);
  } catch (err) {
    await t.rollback();
    console.error('[SEND MESSAGE ERROR]', err);
    return sendResponse(res, 500, false, 'Server error');
  }
};

/* ================= GET CONVERSATION ================= */

exports.getConversation = async (req, res) => {
  try {
    const loggedUser = Number(req.user?.id);
    const otherUserId = Number(req.params.userId);

    console.log('[GET CONVERSATION]', { loggedUser, otherUserId });

    if (!loggedUser) return sendResponse(res, 401, false, 'Unauthorized');
    if (!otherUserId) return sendResponse(res, 400, false, 'Invalid userId');

    const { page, limit, offset } = parsePagination(req);

    const where = {
      [Op.or]: [
        { senderId: loggedUser, receiverId: otherUserId },
        { senderId: otherUserId, receiverId: loggedUser }
      ]
    };

    console.log('[CONVERSATION WHERE]', where);

    // 🔥 DESC for performance
    const { rows, count } = await Message.findAndCountAll({
      where,
      order: [['createdAt', 'DESC']],
      limit,
      offset
    });

    console.log('[MESSAGES FETCHED]', { count: rows.length });

    const userIds = [...new Set(rows.flatMap(m => [m.senderId, m.receiverId]))];

    const users = await User.findAll({
      where: { id: userIds },
      attributes: ['id', 'name', 'email', 'role', 'profileImage']
    });

    const userMap = Object.fromEntries(users.map(u => [u.id, u]));

    // 🔥 Reverse for UI (chat order)
    const messages = rows.reverse().map(m => ({
      id: m.id,
      senderId: m.senderId,
      receiverId: m.receiverId,
      message: m.message,
      isRead: m.isRead,
      createdAt: m.createdAt,
      isMine: m.senderId === loggedUser,
      sender: userMap[m.senderId] || null,
      receiver: userMap[m.receiverId] || null
    }));

    return paginatedResponse(res, 'Conversation fetched', messages, count, page, limit);
  } catch (err) {
    console.error('[GET CONVERSATION ERROR]', err);
    return sendResponse(res, 500, false, 'Server error');
  }
};

/* ================= CHAT LIST ================= */

exports.getChatList = async (req, res) => {
  try {
    const userId = Number(req.user?.id);
    if (!userId) return sendResponse(res, 401, false, 'Unauthorized');

    const { page, limit, offset } = parsePagination(req);

    console.log('[CHAT LIST]', { userId });

    // 🔥 FIXED: camelCase columns + DESC
    const conversations = await Message.findAll({
      attributes: [
        [
          Sequelize.literal(`
            CASE
              WHEN "senderId" = ${userId} THEN "receiverId"
              ELSE "senderId"
            END
          `),
          'otherUserId'
        ],
        [Sequelize.fn('MAX', Sequelize.col('createdAt')), 'lastAt']
      ],
      where: {
        [Op.or]: [{ senderId: userId }, { receiverId: userId }]
      },
      group: ['otherUserId'],
      order: [[Sequelize.literal('lastAt'), 'DESC']],
      limit,
      offset,
      raw: true
    });

    console.log('[CONVERSATIONS FOUND]', conversations.length);

    if (!conversations.length)
      return paginatedResponse(res, 'Chat list fetched', [], 0, page, limit);

    const otherIds = conversations.map(c => c.otherUserId);

    const users = await User.findAll({
      where: { id: otherIds },
      attributes: ['id', 'name', 'email', 'profileImage']
    });

    const userMap = Object.fromEntries(users.map(u => [u.id, u]));

    const unreadCounts = await Message.findAll({
      attributes: ['senderId', [Sequelize.fn('COUNT', '*'), 'count']],
      where: {
        receiverId: userId,
        senderId: otherIds,
        isRead: false
      },
      group: ['senderId'],
      raw: true
    });

    const unreadMap = Object.fromEntries(unreadCounts.map(u => [u.senderId, u.count]));

    const chatList = conversations.map(c => ({
      withUser: userMap[c.otherUserId] || { id: c.otherUserId },
      unreadCount: unreadMap[c.otherUserId] || 0,
      lastAt: c.lastAt
    }));

    return paginatedResponse(res, 'Chat list fetched', chatList, chatList.length, page, limit);
  } catch (err) {
    console.error('[CHAT LIST ERROR]', err);
    return sendResponse(res, 500, false, 'Server error');
  }
};

/* ================= MARK AS READ ================= */

exports.markAsRead = async (req, res) => {
  try {
    const userId = Number(req.user?.id);
    const { conversationWith } = req.body;

    console.log('[MARK AS READ]', { userId, conversationWith });

    if (!userId) return sendResponse(res, 401, false, 'Unauthorized');
    if (!conversationWith)
      return sendResponse(res, 400, false, 'conversationWith required');

    const [updated] = await Message.update(
      { isRead: true },
      {
        where: {
          senderId: conversationWith,
          receiverId: userId,
          isRead: false
        }
      }
    );

    console.log('[MESSAGES MARKED READ]', updated);

    return sendResponse(res, 200, true, 'Messages marked as read', { updated });
  } catch (err) {
    console.error('[MARK AS READ ERROR]', err);
    return sendResponse(res, 500, false, 'Server error');
  }
};