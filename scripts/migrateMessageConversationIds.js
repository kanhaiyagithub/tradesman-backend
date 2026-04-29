require('dotenv').config();

const { DataTypes, QueryTypes } = require('sequelize');
const sequelize = require('../config/db');
const Conversation = require('../models/conversationModel');
const ConversationParticipant = require('../models/conversationParticipantModel');

/**
 * Reads lightweight CLI flags for the Phase 4 message migration.
 *
 * Supported examples:
 * - node scripts/migrateMessageConversationIds.js
 * - node scripts/migrateMessageConversationIds.js --dry-run
 *
 * @param {string[]} argv - Raw CLI args after node and script path.
 * @returns {{ dryRun: boolean }} Parsed options.
 */
const parseCliArgs = (argv) => ({
  dryRun: argv.includes('--dry-run'),
});

/**
 * Ensures the message table has the new nullable `conversationId` column.
 *
 * This script intentionally uses `queryInterface` instead of relying on
 * `sequelize.sync()` so production databases can be upgraded safely without
 * requiring `sync({ alter: true })`.
 *
 * @returns {Promise<void>}
 */
const ensureConversationIdColumn = async () => {
  const queryInterface = sequelize.getQueryInterface();
  const table = await queryInterface.describeTable('messages');

  if (!table.conversationId) {
    await queryInterface.addColumn('messages', 'conversationId', {
      type: DataTypes.BIGINT,
      allowNull: true,
      after: 'id',
    });

    console.log('[CHAT MESSAGE MIGRATION] Added messages.conversationId column');
  }

  const indexes = await queryInterface.showIndex('messages');
  const hasConversationIndex = indexes.some(
    (index) => index.name === 'idx_messages_conversation_id_created'
  );

  if (!hasConversationIndex) {
    await queryInterface.addIndex('messages', ['conversationId', 'createdAt'], {
      name: 'idx_messages_conversation_id_created',
    });

    console.log('[CHAT MESSAGE MIGRATION] Added conversationId history index');
  }
};

/**
 * Ensures the conversation summary tables exist before message rows are linked.
 *
 * @returns {Promise<void>}
 */
const ensureChatSummaryTables = async () => {
  await Conversation.sync();
  await ConversationParticipant.sync();
};

/**
 * Counts how many message rows still need a `conversationId` value.
 *
 * @returns {Promise<number>} Remaining row count.
 */
const countPendingMessageRows = async () => {
  const [result] = await sequelize.query(
    `
      SELECT COUNT(*) AS pendingCount
      FROM messages m
      INNER JOIN conversations c
        ON c.directKey = m.conversationKey
      WHERE m.conversationId IS NULL
         OR m.conversationId <> c.id
    `,
    {
      type: QueryTypes.SELECT,
    }
  );

  return Number(result?.pendingCount || 0);
};

/**
 * Copies conversation ids from summary rows into historical message rows.
 *
 * The JOIN-based update is efficient for MySQL and keeps the migration
 * idempotent, so it can be re-run safely after partial deploys.
 *
 * @returns {Promise<number>} Number of rows matched by the update.
 */
const backfillMessageConversationIds = async () => {
  const [, metadata] = await sequelize.query(
    `
      UPDATE messages m
      INNER JOIN conversations c
        ON c.directKey = m.conversationKey
      SET m.conversationId = c.id
      WHERE m.conversationId IS NULL
         OR m.conversationId <> c.id
    `
  );

  return Number(metadata?.affectedRows ?? metadata ?? 0);
};

/**
 * Runs the Phase 4 message migration.
 *
 * @returns {Promise<void>}
 */
const main = async () => {
  const options = parseCliArgs(process.argv.slice(2));

  console.log('[CHAT MESSAGE MIGRATION] Starting', options);

  await ensureChatSummaryTables();
  await ensureConversationIdColumn();

  const pendingRows = await countPendingMessageRows();

  if (options.dryRun) {
    console.log('[CHAT MESSAGE MIGRATION][DRY RUN] Pending rows:', pendingRows);
    return;
  }

  if (!pendingRows) {
    console.log('[CHAT MESSAGE MIGRATION] No rows needed updating');
    return;
  }

  const updatedRows = await backfillMessageConversationIds();
  console.log('[CHAT MESSAGE MIGRATION] Completed', {
    pendingRows,
    updatedRows,
  });
};

main()
  .then(async () => {
    await sequelize.close();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error('[CHAT MESSAGE MIGRATION] Fatal error', error);
    await sequelize.close();
    process.exit(1);
  });
