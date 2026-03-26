let io = null;

// userId -> socketId
const onlineUsers = new Map();

module.exports = {
  init: (server) => {
    const { Server } = require("socket.io");

    io = new Server(server, {
      cors: {
        origin: "*",
        methods: ["GET", "POST"],
      },
    });

    io.on("connection", (socket) => {
      console.log("🟢 Socket connected:", socket.id);

      /**
       * REGISTER USER
       * payload: { userId }
       */
      socket.on("register", ({ userId }) => {
        console.log("[REGISTER] payload:", { userId });

        if (!userId) {
          console.log("[REGISTER] userId missing");
          return;
        }

        onlineUsers.set(String(userId), socket.id);
        socket.userId = String(userId);

        console.log("👤 User registered:", userId);
      });

      /**
       * JOIN CHAT ROOM
       * payload: { roomId }
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
       * payload: { roomId, senderId, message }
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

        // emit to all users in room
        console.log("[RECEIVE-MESSAGE] emitting to room:", String(roomId), payload);
        io.to(String(roomId)).emit("receive-message", payload);

        // save to DB
        try {
          console.log("[DB] loading ./config/db");
          const db = require("./config/db");

          console.log("[DB] object info:", {
            type: typeof db,
            hasExecute: typeof db.execute === "function",
          });

          const result = await db.execute(
            `INSERT INTO messages (room_id, sender_id, message)
             VALUES (?, ?, ?)`,
            [roomId, senderId, message]
          );

          console.log("[DB] insert success:", result);
        } catch (err) {
          console.error("❌ MySQL insert failed:", err.message);
        }
      });

      /**
       * DISCONNECT
       */
      socket.on("disconnect", () => {
        if (socket.userId) {
          onlineUsers.delete(socket.userId);
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