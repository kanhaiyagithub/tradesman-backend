let io = null;

// userId -> socketId
const onlineUsers = new Map();

module.exports = {
  init: (server) => {
    const { Server } = require("socket.io");

    io = new Server(server, {
      cors: {
        origin: "*",
        methods: ["GET", "POST"]
      }
    });

    io.on("connection", (socket) => {
      console.log("🟢 Socket connected:", socket.id);

      /**
       * REGISTER USER
       * payload: { userId }
       */
      socket.on("register", ({ userId }) => {
        if (!userId) return;

        onlineUsers.set(String(userId), socket.id);
        socket.userId = String(userId);

        console.log("👤 User registered:", userId);
      });

      /**
       * JOIN CHAT ROOM
       * payload: { roomId }
       */
      socket.on("join-room", ({ roomId }) => {
        if (!roomId) return;

        socket.join(String(roomId));
        console.log(`📥 Socket ${socket.id} joined room ${roomId}`);
      });

      /**
       * SEND MESSAGE
       * payload: { roomId, senderId, message }
       */
      socket.on("send-message", async ({ roomId, senderId, message }) => {
        if (!roomId || !senderId || !message) return;

        // 👉 1. Emit message to room
        io.to(String(roomId)).emit("receive-message", {
          roomId,
          senderId,
          message,
          createdAt: new Date()
        });

        // 👉 2. SAVE TO MYSQL (async, non-blocking)
        try {
          const db = require("./db"); // mysql2 pool
          await db.execute(
            `INSERT INTO messages (room_id, sender_id, message)
             VALUES (?, ?, ?)`,
            [roomId, senderId, message]
          );
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
  }
};