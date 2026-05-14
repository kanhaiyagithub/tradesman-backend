const { DataTypes } = require('sequelize');

const TABLE_NAME = 'notifications';

/**
 * Checks whether a table exists, comparing names case-insensitively for MySQL.
 *
 * @param {import('sequelize').QueryInterface} queryInterface - Sequelize query interface.
 * @param {string} tableName - Table name to check.
 * @returns {Promise<boolean>} True when the table exists.
 */
const tableExists = async (queryInterface, tableName) => {
  const tables = await queryInterface.showAllTables();
  const normalizedTarget = String(tableName).toLowerCase();

  return tables.some((entry) => {
    const currentName = typeof entry === 'string'
      ? entry
      : entry.tableName || entry.table_name || '';

    return String(currentName).toLowerCase() === normalizedTarget;
  });
};

module.exports = {
  /**
   * Creates the persistent notification inbox table.
   *
   * @param {{ context: import('sequelize').QueryInterface }} params - Umzug migration context.
   * @returns {Promise<void>}
   */
  up: async ({ context: queryInterface }) => {
    if (await tableExists(queryInterface, TABLE_NAME)) {
      console.log(`[MIGRATION] Table already exists, skipping create: ${TABLE_NAME}`);
      return;
    }

    await queryInterface.createTable(TABLE_NAME, {
      id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false,
      },
      userId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: { model: 'Users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      title: {
        type: DataTypes.STRING(160),
        allowNull: false,
      },
      body: {
        type: DataTypes.TEXT,
        allowNull: false,
      },
      type: {
        type: DataTypes.STRING(60),
        allowNull: false,
        defaultValue: 'general',
      },
      data: {
        type: DataTypes.JSON,
        allowNull: true,
      },
      isRead: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      readAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      deliveryStatus: {
        type: DataTypes.ENUM('pending', 'sent', 'failed', 'skipped'),
        allowNull: false,
        defaultValue: 'pending',
      },
      deliveryError: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },
      sentAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      expiresAt: {
        type: DataTypes.DATE,
        allowNull: false,
      },
      createdAt: {
        type: DataTypes.DATE,
        allowNull: false,
      },
      updatedAt: {
        type: DataTypes.DATE,
        allowNull: false,
      },
    });

    await queryInterface.addIndex(TABLE_NAME, {
      name: 'idx_notifications_user_created_at',
      fields: ['userId', 'createdAt'],
    });

    await queryInterface.addIndex(TABLE_NAME, {
      name: 'idx_notifications_user_read_created_at',
      fields: ['userId', 'isRead', 'createdAt'],
    });

    await queryInterface.addIndex(TABLE_NAME, {
      name: 'idx_notifications_expires_at',
      fields: ['expiresAt'],
    });
  },

  /**
   * Drops the notification inbox table.
   *
   * @param {{ context: import('sequelize').QueryInterface }} params - Umzug migration context.
   * @returns {Promise<void>}
   */
  down: async ({ context: queryInterface }) => {
    if (await tableExists(queryInterface, TABLE_NAME)) {
      await queryInterface.dropTable(TABLE_NAME);
    }
  },
};
