// models/messageModel.js
const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');

const Message = sequelize.define(
  'Message',
  {
    id: {
      type: DataTypes.BIGINT,
      autoIncrement: true,
      primaryKey: true
    },

    senderId: {
      type: DataTypes.INTEGER,
      allowNull: false
    },

    receiverId: {
      type: DataTypes.INTEGER,
      allowNull: false
    },

    /**
     * conversationKey = "smallerId_biggerId"
     * Example: users 3 and 9 => "3_9"
     * Helps fast conversation queries
     */
    conversationKey: {
      type: DataTypes.STRING,
      allowNull: false
    },

    message: {
      type: DataTypes.TEXT,
      allowNull: false
    },

    isRead: {
      type: DataTypes.BOOLEAN,
      defaultValue: false
    },

    deletedAt: {
      type: DataTypes.DATE,
      allowNull: true
    }
  },
  {
    tableName: 'messages',
    timestamps: true,
    paranoid: true, // enables soft delete using deletedAt

    indexes: [
      {
        name: 'idx_conversation_created',
        fields: ['conversationKey', 'createdAt']
      },
      {
        name: 'idx_receiver_read',
        fields: ['receiverId', 'isRead']
      },
      {
        name: 'idx_sender_receiver',
        fields: ['senderId', 'receiverId']
      }
    ]
  }
);

/**
 * Auto-generate conversationKey before validation
 */
Message.beforeValidate((msg) => {
  if (msg.senderId && msg.receiverId) {
    const a = Math.min(msg.senderId, msg.receiverId);
    const b = Math.max(msg.senderId, msg.receiverId);
    msg.conversationKey = `${a}_${b}`;
  }
});

module.exports = Message;