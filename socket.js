const jwt = require("jsonwebtoken");
const { processLiveLocation } = require("./services/liveLocationService");
const chatService = require("./services/chatService");

let io = null;

// userId -> Set(socketId)
const onlineUsers = new Map();

// throttling map: userId -> last processed timestamp
const liveLocationThrottle = new Map();

const LIVE_LOCATION_MIN_INTERVAL_MS = 5000;

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
        origin: "*",
        methods: ["GET", "POST"],
      },
    });

    io.use((socket, next) => {
      try {
        const token =
          socket.handshake.headers?.authorization?.replace("Bearer ", "") ||
          socket.handshake.auth?.token;

        if (!token) {
          return next(new Error("Unauthorized: No token provided"));
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        socket.user = decoded;
        next();
      } catch (error) {
        console.error("[SOCKET AUTH ERROR]", error.message);
        next(new Error("Unauthorized"));
      }
    });

    io.on("connection", (socket) => {
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

      socket.on("join-room", ({ roomId }) => {
        if (!roomId) {
          return;
        }

        socket.join(String(roomId));
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
          console.log("[SOCKET MESSAGE RECEIVED]", {
            senderId,
            receiverId,
            preview: message.substring(0, 60),
          });

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
          const { latitude, longitude } = payload;

          if (!tradesmanId) {
            if (typeof ack === "function") {
              ack({ success: false, message: "Unauthorized socket user" });
            }
            return;
          }

          if (
            latitude === undefined ||
            latitude === null ||
            longitude === undefined ||
            longitude === null
          ) {
            if (typeof ack === "function") {
              ack({
                success: false,
                message: "latitude and longitude are required",
              });
            }
            return;
          }

          const lat = Number(latitude);
          const lng = Number(longitude);

          if (Number.isNaN(lat) || Number.isNaN(lng)) {
            if (typeof ack === "function") {
              ack({
                success: false,
                message: "latitude and longitude must be valid numbers",
              });
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
            latitude: lat,
            longitude: lng,
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
};
