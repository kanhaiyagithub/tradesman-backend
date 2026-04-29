const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');
const Conversation = require('./conversationModel');

const ConversationParticipant = sequelize.define(
  'ConversationParticipant',
  {
    id: {
      type: DataTypes.BIGINT,
      autoIncrement: true,
      primaryKey: true,
    },
    conversationId: {
      type: DataTypes.BIGINT,
      allowNull: false,
      references: {
        model: 'conversations',
        key: 'id',
      },
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    otherUserId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    unreadCount: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    lastReadMessageId: {
      type: DataTypes.BIGINT,
      allowNull: true,
    },
    lastReadAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    tableName: 'conversation_participants',
    timestamps: true,
    indexes: [
      {
        name: 'uq_conversation_user',
        unique: true,
        fields: ['conversationId', 'userId'],
      },
      {
        name: 'uq_user_other_user',
        unique: true,
        fields: ['userId', 'otherUserId'],
      },
      {
        name: 'idx_participant_user',
        fields: ['userId'],
      },
      {
        name: 'idx_participant_user_unread',
        fields: ['userId', 'unreadCount'],
      },
    ],
  }
);

Conversation.hasMany(ConversationParticipant, {
  foreignKey: 'conversationId',
  as: 'participants',
});

ConversationParticipant.belongsTo(Conversation, {
  foreignKey: 'conversationId',
  as: 'conversation',
});

module.exports = ConversationParticipant;
