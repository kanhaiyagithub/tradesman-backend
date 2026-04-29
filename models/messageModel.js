const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');
const Conversation = require('./conversationModel');

/**
 * Stores direct chat history.
 *
 * Phase 4 note:
 * - `conversationId` is the long-term primary relation for history reads.
 * - `conversationKey` is still kept for backward compatibility and safe rollout.
 * - Existing rows can be backfilled gradually without breaking the frontend.
 */
const Message = sequelize.define(
  'Message',
  {
    id: {
      type: DataTypes.BIGINT,
      autoIncrement: true,
      primaryKey: true,
    },

    /**
     * Strong relation to the conversation summary row.
     *
     * This starts nullable so old rows can be migrated safely in batches.
     */
    conversationId: {
      type: DataTypes.BIGINT,
      allowNull: true,
    },

    senderId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },

    receiverId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },

    /**
     * Stable user-pair key in the format "smallerId_biggerId".
     *
     * This remains available during the migration window and still helps
     * operational scripts target a conversation even before all rows have a
     * `conversationId` value.
     */
    conversationKey: {
      type: DataTypes.STRING,
      allowNull: false,
    },

    message: {
      type: DataTypes.TEXT,
      allowNull: false,
    },

    isRead: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },

    deletedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    tableName: 'messages',
    timestamps: true,
    paranoid: true,
    indexes: [
      {
        name: 'idx_messages_conversation_id_created',
        fields: ['conversationId', 'createdAt'],
      },
      {
        name: 'idx_conversation_created',
        fields: ['conversationKey', 'createdAt'],
      },
      {
        name: 'idx_receiver_read',
        fields: ['receiverId', 'isRead'],
      },
      {
        name: 'idx_sender_receiver',
        fields: ['senderId', 'receiverId'],
      },
    ],
  }
);

/**
 * Auto-generates the stable direct-message key before validation.
 *
 * This keeps legacy queries and migration scripts deterministic even while the
 * system transitions to `conversationId`-driven reads.
 *
 * @param {import('sequelize').Model & { senderId?: number, receiverId?: number, conversationKey?: string }} msg
 * @returns {void}
 */
Message.beforeValidate((msg) => {
  if (msg.senderId && msg.receiverId) {
    const a = Math.min(msg.senderId, msg.receiverId);
    const b = Math.max(msg.senderId, msg.receiverId);
    msg.conversationKey = `${a}_${b}`;
  }
});

Conversation.hasMany(Message, {
  foreignKey: 'conversationId',
  as: 'messages',
});

Message.belongsTo(Conversation, {
  foreignKey: 'conversationId',
  as: 'conversation',
});

module.exports = Message;
