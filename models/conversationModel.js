const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');

const Conversation = sequelize.define(
  'Conversation',
  {
    id: {
      type: DataTypes.BIGINT,
      autoIncrement: true,
      primaryKey: true,
    },
    directKey: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },
    userOneId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    userTwoId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    lastMessageId: {
      type: DataTypes.BIGINT,
      allowNull: true,
    },
    lastMessageSenderId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    lastMessagePreview: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    lastMessageAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    tableName: 'conversations',
    timestamps: true,
    indexes: [
      {
        name: 'uq_conversations_direct_key',
        unique: true,
        fields: ['directKey'],
      },
      {
        name: 'idx_conversations_last_message_at',
        fields: ['lastMessageAt'],
      },
      {
        name: 'idx_conversations_user_one',
        fields: ['userOneId'],
      },
      {
        name: 'idx_conversations_user_two',
        fields: ['userTwoId'],
      },
    ],
  }
);

module.exports = Conversation;
