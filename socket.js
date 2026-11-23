const { verifyAccessToken, verifyAdminJwt } = require("./utils/authTokens");
const Admin = require("./models/AdminModel/adminModel");
const { processLiveLocation } = require("./services/liveLocationService");
const chatService = require("./services/chatService");
const { isOriginAllowed } = require("./utils/securityConfig");
const { parseLiveCoordinates } = require("./utils/liveLocationValidation");

const ADMIN_ROOM = "admins";

let io = null;

// userId -> Set(socketId)
const onlineUsers = new Map();

// throttling map: userId -> last processed timestamp
const liveLocationThrottle = new Map();

const LIVE_LOCATION_MIN_INTERVAL_MS = 5000;

// Per-user send-message limit: at most MESSAGE_LIMIT messages per window.
const MESSAGE_LIMIT = 20;
const MESSAGE_WINDOW_MS = 10 * 1000;
const messageHits = new Map();

const allowSocketMessage = (userId) => {
  const now = Date.now();
  const hits = (messageHits.get(userId) || []).filter((at) => now - at < MESSAGE_WINDOW_MS);

  if (hits.length >= MESSAGE_LIMIT) {
    messageHits.set(userId, hits);
    return false;
  }

  hits.push(now);
  messageHits.set(userId, hits);
  return true;
};

const validateSocketLiveLocation = (user, payload = {}) => {
  if (!user?.id) {
    return { success: false, message: "Unauthorized socket user" };
  }

  if (user.role !== "tradesman") {
    return { success: false, message: "Only tradesmen can update live location" };
  }

  return parseLiveCoordinates(payload);
};

const addSocketForUser = (userId, socketId) => {
  const normalizedUserId = String(userId || "").trim();
  if (!normalizedUserId) return;

  const currentSockets = onlineUsers.get(normalizedUserId) || new Set();
  currentSockets.add(socketId);
  onlineUsers.set(normalizedUserId, currentSockets);
};

const removeSocketForUser = (userId, socketId) => {
  const normalizedUserId = String(userId || "").trim();
  if (!normalizedUserId) return;

  const currentSockets = onlineUsers.get(normalizedUserId);
  if (!currentSockets) return;

  currentSockets.delete(socketId);

  if (!currentSockets.size) {
    onlineUsers.delete(normalizedUserId);
    return;
  }

  onlineUsers.set(normalizedUserId, currentSockets);
};

const emitToUser = (userId, eventName, payload, options = {}) => {
  const normalizedUserId = String(userId || "").trim();
  if (!io || !normalizedUserId) return;

  const socketIds = onlineUsers.get(normalizedUserId);
  if (!socketIds || !socketIds.size) return;

  for (const socketId of socketIds) {
    if (options.excludeSocketId && socketId === options.excludeSocketId) {
      continue;
    }
    io.to(socketId).emit(eventName, payload);
  }
};

module.exports = {
  init: (server) => {
    const { Server } = require("socket.io");

    io = new Server(server, {
      cors: {
        origin(origin, callback) {
          if (isOriginAllowed(origin)) {
            return callback(null, true);
          }

          return callback(new Error("Socket origin is not allowed"));
        },
        methods: ["GET", "POST"],
        credentials: true,
      },
    });

    io.use(async (socket, next) => {
      try {
        const token =
          socket.handshake.headers?.authorization?.replace("Bearer ", "") ||
          socket.handshake.auth?.token;

        if (!token) {
          return next(new Error("Unauthorized: No token provided"));
        }

        // Admin tokens have their own secret and carry Admin ids, not User ids.
        // They must never be treated as a user (chat, live location, online map).
        let decoded;
        try {
          decoded = verifyAccessToken(token);
        } catch (userTokenError) {
          if (userTokenError.name === "TokenExpiredError") throw userTokenError;
          decoded = verifyAdminJwt(token);
          const admin = await Admin.findByPk(decoded.id);
          if (!admin) return next(new Error("Unauthorized"));
          socket.isAdmin = true;
        }

        socket.user = decoded;
        // The token is only checked at connect, so drop the socket when it expires.
        if (decoded.exp) {
          const expiryTimer = setTimeout(
            () => socket.disconnect(true),
            Math.max(decoded.exp * 1000 - Date.now(), 0)
          );
          expiryTimer.unref?.();
          socket.once("disconnect", () => clearTimeout(expiryTimer));
        }
        next();
      } catch (error) {
        console.error("[SOCKET AUTH ERROR]", error.message);
        next(new Error("Unauthorized"));
      }
    });

    io.on("connection", (socket) => {
      // Admin dashboards only listen on the "admins" room; none of the user handlers apply.
      if (socket.isAdmin) {
        socket.join(ADMIN_ROOM);
        socket.emit("admin:ready");
        return;
      }

      const resolvedUserId = String(socket.user?.id || "").trim();

      console.log("🟢 Socket connected:", {
        socketId: socket.id,
        userId: resolvedUserId || null,
      });

      if (resolvedUserId) {
        addSocketForUser(resolvedUserId, socket.id);
        socket.userId = resolvedUserId;
      }

      socket.on("register", ({ userId } = {}) => {
        const finalUserId = String(socket.user?.id || userId || "").trim();
        if (!finalUserId) {
          return;
        }

        addSocketForUser(finalUserId, socket.id);
        socket.userId = finalUserId;
      });

      socket.on("send-message", async (payload = {}, ack) => {
        try {
          const senderId = Number(socket.user?.id || payload.senderId);
          const receiverId = Number(payload.receiverId || payload.roomId);
          const message = String(payload.message || "").trim();

          if (!senderId || !receiverId || !message) {
            const response = {
              success: false,
              message: "receiverId and message are required",
            };

            if (typeof ack === "function") ack(response);
            return;
          }
          if (!allowSocketMessage(senderId)) {
            const response = {
              success: false,
              message: "You are sending messages too quickly. Please slow down.",
            };

            if (typeof ack === "function") ack(response);
            return;
          }

          const savedMessage = await chatService.sendDirectMessage({
            senderId,
            receiverId,
            message,
          });

          emitToUser(receiverId, "receive-message", savedMessage, {
            excludeSocketId: socket.id,
          });

          emitToUser(senderId, "receive-message", savedMessage, {
            excludeSocketId: socket.id,
          });

          if (typeof ack === "function") {
            ack({
              success: true,
              data: savedMessage,
            });
          }
        } catch (error) {
          console.error("[SEND MESSAGE SOCKET ERROR]", {
            message: error.message,
            stack: error.stack,
          });

          if (typeof ack === "function") {
            ack({
              success: false,
              message: error.message || "Failed to send message",
            });
          }
        }
      });

      socket.on("message-received", (payload = {}) => {
        console.log("[MESSAGE RECEIVED ACK]", {
          socketId: socket.id,
          userId: socket.userId || socket.user?.id,
          payload,
          at: new Date().toISOString(),
        });
      });

      socket.on("live-location:update", async (payload = {}, ack) => {
        try {
          const tradesmanId = socket.user?.id;

          const validation = validateSocketLiveLocation(socket.user, payload);
          if (!validation.success) {
            if (typeof ack === "function") {
              ack({ success: false, message: validation.message });
            }
            return;
          }

          const lastProcessedAt = liveLocationThrottle.get(String(tradesmanId));
          const now = Date.now();

          if (
            lastProcessedAt &&
            now - lastProcessedAt < LIVE_LOCATION_MIN_INTERVAL_MS
          ) {
            if (typeof ack === "function") {
              ack({
                success: true,
                skipped: true,
                reason: "THROTTLED",
              });
            }
            return;
          }

          liveLocationThrottle.set(String(tradesmanId), now);

          const result = await processLiveLocation({
            tradesmanId,
            latitude: validation.latitude,
            longitude: validation.longitude,
          });

          if (typeof ack === "function") {
            ack({ success: true, data: result });
          }
        } catch (error) {
          console.error("[LIVE SOCKET ERROR]", {
            message: error.message,
            stack: error.stack,
          });

          if (typeof ack === "function") {
            ack({ success: false, message: error.message });
          }
        }
      });

      socket.on("disconnect", () => {
        if (socket.userId) {
          removeSocketForUser(socket.userId, socket.id);
          liveLocationThrottle.delete(socket.userId);
          console.log("🔴 User disconnected:", socket.userId);
        } else {
          console.log("🔴 Socket disconnected:", socket.id);
        }
      });
    });
  },

  getIO: () => {
    if (!io) {
      throw new Error("Socket.io not initialized");
    }
    return io;
  },

  getOnlineUsers: () => onlineUsers,
  emitToUser,
  validateSocketLiveLocation,
};
