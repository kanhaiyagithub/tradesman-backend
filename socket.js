const jwt = require("jsonwebtoken");
const { processLiveLocation } = require("./services/liveLocationService");

let io = null;

// userId -> socketId
const onlineUsers = new Map();

// throttling map: userId -> last processed timestamp
const liveLocationThrottle = new Map();

const LIVE_LOCATION_MIN_INTERVAL_MS = 5000;

module.exports = {
  init: (server) => {
    const { Server } = require("socket.io");

    io = new Server(server, {
      cors: {
        origin: "*",
        methods: ["GET", "POST"],
      },
    });

    // Socket authentication middleware
    io.use((socket, next) => {
      try {
        const token =
          socket.handshake.auth?.token ||
          socket.handshake.headers?.authorization?.replace("Bearer ", "");

        if (!token) {
          return next(new Error("Unauthorized: No token provided"));
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        socket.user = decoded; // { id, email, role, ... }
        next();
      } catch (error) {
        console.error("[SOCKET AUTH ERROR]", error.message);
        next(new Error("Unauthorized"));
      }
    });

    io.on("connection", (socket) => {
      console.log("🟢 Socket connected:", {
        socketId: socket.id,
        userId: socket.user?.id,
      });

      const resolvedUserId = String(socket.user?.id || "");

      if (resolvedUserId) {
        onlineUsers.set(resolvedUserId, socket.id);
        socket.userId = resolvedUserId;

        console.log("👤 User auto-registered:", {
          userId: resolvedUserId,
          socketId: socket.id,
        });
      } else {
        console.log("[AUTO-REGISTER] userId missing from auth token");
      }

      /**
       * REGISTER USER
       * optional for chat presence mapping
       */
      socket.on("register", ({ userId } = {}) => {
        const resolvedUserId = String(socket.user?.id || userId || "");

        console.log("[REGISTER] payload:", {
          payloadUserId: userId,
          authUserId: socket.user?.id,
          resolvedUserId,
        });

        if (!resolvedUserId) {
          console.log("[REGISTER] userId missing");
          return;
        }

        onlineUsers.set(resolvedUserId, socket.id);
        socket.userId = resolvedUserId;

        console.log("👤 User registered:", resolvedUserId);
      });

      /**
       * JOIN CHAT ROOM
       */
      socket.on("join-room", ({ roomId }) => {
        console.log("[JOIN-ROOM] payload:", { roomId });

        if (!roomId) {
          console.log("[JOIN-ROOM] roomId missing");
          return;
        }

        socket.join(String(roomId));
        console.log(`📥 Socket ${socket.id} joined room ${roomId}`);
      });

      /**
       * SEND MESSAGE
       */
      socket.on("send-message", async ({ roomId, senderId, message }) => {
        console.log("[SEND-MESSAGE] payload:", {
          roomId,
          senderId,
          message,
        });

        if (!roomId || !senderId || !message) {
          console.log("[SEND-MESSAGE] validation failed", {
            hasRoomId: !!roomId,
            hasSenderId: !!senderId,
            hasMessage: !!message,
          });
          return;
        }

        const payload = {
          roomId,
          senderId,
          message,
          createdAt: new Date(),
        };

        io.to(String(roomId)).emit("receive-message", payload);

        try {
          const db = require("./config/db");

          await db.execute(
            `INSERT INTO messages (room_id, sender_id, message)
             VALUES (?, ?, ?)`,
            [roomId, senderId, message],
          );

          console.log("[DB] message insert success");
        } catch (err) {
          console.error("❌ MySQL insert failed:", err.message);
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

      /**
       * LIVE LOCATION UPDATE
       * payload: { latitude, longitude }
       */
      socket.on("live-location:update", async (payload = {}, ack) => {
        try {
          const tradesmanId = socket.user?.id;
          const { latitude, longitude } = payload;

          console.log("[LIVE SOCKET] Event received", {
            tradesmanId,
            latitude,
            longitude,
            at: new Date().toISOString(),
          });

          if (!tradesmanId) {
            const response = {
              success: false,
              message: "Unauthorized socket user",
            };

            if (typeof ack === "function") ack(response);
            return;
          }

          if (
            latitude === undefined ||
            latitude === null ||
            longitude === undefined ||
            longitude === null
          ) {
            const response = {
              success: false,
              message: "latitude and longitude are required",
            };

            if (typeof ack === "function") ack(response);
            return;
          }

          const lat = Number(latitude);
          const lng = Number(longitude);

          if (Number.isNaN(lat) || Number.isNaN(lng)) {
            const response = {
              success: false,
              message: "latitude and longitude must be valid numbers",
            };

            if (typeof ack === "function") ack(response);
            return;
          }

          // basic throttling
          const lastProcessedAt = liveLocationThrottle.get(String(tradesmanId));
          const now = Date.now();

          if (
            lastProcessedAt &&
            now - lastProcessedAt < LIVE_LOCATION_MIN_INTERVAL_MS
          ) {
            const response = {
              success: true,
              skipped: true,
              reason: "THROTTLED",
            };

            if (typeof ack === "function") ack(response);
            return;
          }

          liveLocationThrottle.set(String(tradesmanId), now);

          const result = await processLiveLocation({
            tradesmanId,
            latitude: lat,
            longitude: lng,
          });

          console.log("[LIVE SOCKET] Location processed", {
            tradesmanId,
            result,
          });

          if (typeof ack === "function") {
            ack({
              success: true,
              data: result,
            });
          }
        } catch (error) {
          console.error("[LIVE SOCKET ERROR]", {
            message: error.message,
            stack: error.stack,
          });

          if (typeof ack === "function") {
            ack({
              success: false,
              message: error.message,
            });
          }
        }
      });

      socket.on("disconnect", () => {
        if (socket.userId) {
          onlineUsers.delete(socket.userId);
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

  getOnlineUsers: () => {
    return onlineUsers;
  },
};

// let io = null;

// // userId -> socketId
// const onlineUsers = new Map();

// module.exports = {
//   init: (server) => {
//     const { Server } = require("socket.io");

//     io = new Server(server, {
//       cors: {
//         origin: "*",
//         methods: ["GET", "POST"],
//       },
//     });

//     io.on("connection", (socket) => {
//       console.log("🟢 Socket connected:", socket.id);

//       /**
//        * REGISTER USER
//        * payload: { userId }
//        */
//       socket.on("register", ({ userId }) => {
//         console.log("[REGISTER] payload:", { userId });

//         if (!userId) {
//           console.log("[REGISTER] userId missing");
//           return;
//         }

//         onlineUsers.set(String(userId), socket.id);
//         socket.userId = String(userId);

//         console.log("👤 User registered:", userId);
//       });

//       /**
//        * JOIN CHAT ROOM
//        * payload: { roomId }
//        */
//       socket.on("join-room", ({ roomId }) => {
//         console.log("[JOIN-ROOM] payload:", { roomId });

//         if (!roomId) {
//           console.log("[JOIN-ROOM] roomId missing");
//           return;
//         }

//         socket.join(String(roomId));
//         console.log(`📥 Socket ${socket.id} joined room ${roomId}`);
//       });

//       /**
//        * SEND MESSAGE
//        * payload: { roomId, senderId, message }
//        */
//       socket.on("send-message", async ({ roomId, senderId, message }) => {
//         console.log("[SEND-MESSAGE] payload:", {
//           roomId,
//           senderId,
//           message,
//         });

//         if (!roomId || !senderId || !message) {
//           console.log("[SEND-MESSAGE] validation failed", {
//             hasRoomId: !!roomId,
//             hasSenderId: !!senderId,
//             hasMessage: !!message,
//           });
//           return;
//         }

//         const payload = {
//           roomId,
//           senderId,
//           message,
//           createdAt: new Date(),
//         };

//         // emit to all users in room
//         console.log("[RECEIVE-MESSAGE] emitting to room:", String(roomId), payload);
//         io.to(String(roomId)).emit("receive-message", payload);

//         // save to DB
//         try {
//           console.log("[DB] loading ./config/db");
//           const db = require("./config/db");

//           console.log("[DB] object info:", {
//             type: typeof db,
//             hasExecute: typeof db.execute === "function",
//           });

//           const result = await db.execute(
//             `INSERT INTO messages (room_id, sender_id, message)
//              VALUES (?, ?, ?)`,
//             [roomId, senderId, message]
//           );

//           console.log("[DB] insert success:", result);
//         } catch (err) {
//           console.error("❌ MySQL insert failed:", err.message);
//         }
//       });

//       /**
//        * DISCONNECT
//        */
//       socket.on("disconnect", () => {
//         if (socket.userId) {
//           onlineUsers.delete(socket.userId);
//           console.log("🔴 User disconnected:", socket.userId);
//         } else {
//           console.log("🔴 Socket disconnected:", socket.id);
//         }
//       });
//     });
//   },

//   getIO: () => {
//     if (!io) {
//       throw new Error("Socket.io not initialized");
//     }
//     return io;
//   },

//   getOnlineUsers: () => {
//     return onlineUsers;
//   },
// };
