require('dotenv').config();

const { Op, QueryTypes } = require('sequelize');
const sequelize = require('../config/db');
const Message = require('../models/messageModel');
const Conversation = require('../models/conversationModel');
const ConversationParticipant = require('../models/conversationParticipantModel');
const {
  parseConversationKey,
  buildMessagePreview,
} = require('../utils/chatConversation');

const DEFAULT_BATCH_SIZE = 200;

/**
 * Reads lightweight CLI flags used for safe backfill runs.
 *
 * Supported examples:
 * - node scripts/backfillConversations.js
 * - node scripts/backfillConversations.js --dry-run
 * - node scripts/backfillConversations.js --batch-size=100
 * - node scripts/backfillConversations.js --conversation-key=12_45
 *
 * @param {string[]} argv - Raw CLI args after node and script path.
 * @returns {{ dryRun: boolean, batchSize: number, conversationKey: string|null }} Parsed options.
 */
const parseCliArgs = (argv) => {
  const options = {
    dryRun: false,
    batchSize: DEFAULT_BATCH_SIZE,
    conversationKey: null,
  };

  for (const arg of argv) {
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }

    if (arg.startsWith('--batch-size=')) {
      options.batchSize = Math.max(Number(arg.split('=')[1]) || DEFAULT_BATCH_SIZE, 1);
      continue;
    }

    if (arg.startsWith('--conversation-key=')) {
      options.conversationKey = String(arg.split('=')[1] || '').trim() || null;
    }
  }

  return options;
};

/**
 * Returns distinct conversation keys in ascending order using a stable key cursor
 * so the script can process large datasets in batches.
 *
 * @param {{ lastConversationKey?: string|null, batchSize: number, specificConversationKey?: string|null }} params
 * @returns {Promise<string[]>} Next batch of distinct conversation keys.
 */
const fetchConversationKeysBatch = async ({
  lastConversationKey = null,
  batchSize,
  specificConversationKey = null,
}) => {
  if (specificConversationKey) {
    return [specificConversationKey];
  }

  const replacements = {
    batchSize,
  };

  let keyFilterSql = '';

  if (lastConversationKey) {
    replacements.lastConversationKey = lastConversationKey;
    keyFilterSql = 'AND conversationKey > :lastConversationKey';
  }

  const rows = await sequelize.query(
    `
      SELECT conversationKey
      FROM messages
      WHERE conversationKey IS NOT NULL
        AND conversationKey <> ''
        ${keyFilterSql}
      GROUP BY conversationKey
      ORDER BY conversationKey ASC
      LIMIT :batchSize
    `,
    {
      replacements,
      type: QueryTypes.SELECT,
    }
  );

  return rows.map((row) => row.conversationKey).filter(Boolean);
};

/**
 * Finds the latest message a participant can be considered to have seen.
 *
 * The sender always implicitly knows messages they sent. For received messages,
 * only rows already marked as read count toward the historical read pointer.
 *
 * @param {{ conversationKey: string, userId: number, transaction?: import('sequelize').Transaction }} params
 * @returns {Promise<import('sequelize').Model|null>} Latest visible message instance.
 */
const findLatestVisibleMessageForUser = async ({
  conversationKey,
  userId,
  transaction,
}) => {
  return Message.findOne({
    where: {
      conversationKey,
      [Op.or]: [
        { senderId: userId },
        {
          receiverId: userId,
          isRead: true,
        },
      ],
    },
    order: [
      ['createdAt', 'DESC'],
      ['id', 'DESC'],
    ],
    transaction,
  });
};

/**
 * Builds the participant summary state for one side of a direct conversation.
 *
 * @param {{ conversationId: number, userId: number, otherUserId: number, conversationKey: string, latestMessageId: number|null, transaction?: import('sequelize').Transaction }} params
 * @returns {Promise<{ conversationId: number, userId: number, otherUserId: number, unreadCount: number, lastReadMessageId: number|null, lastReadAt: Date|null }>} Upsert-ready participant data.
 */
const buildParticipantSummary = async ({
  conversationId,
  userId,
  otherUserId,
  conversationKey,
  latestMessageId,
  transaction,
}) => {
  const unreadCount = await Message.count({
    where: {
      conversationKey,
      receiverId: userId,
      isRead: false,
    },
    transaction,
  });

  const latestVisibleMessage = await findLatestVisibleMessageForUser({
    conversationKey,
    userId,
    transaction,
  });

  const shouldPointToLatestMessage = unreadCount === 0 && latestMessageId;
  const resolvedLastReadMessageId = shouldPointToLatestMessage
    ? latestMessageId
    : latestVisibleMessage?.id || null;

  return {
    conversationId,
    userId,
    otherUserId,
    unreadCount,
    lastReadMessageId: resolvedLastReadMessageId,
    lastReadAt: latestVisibleMessage?.createdAt || null,
  };
};

/**
 * Checks whether the `messages` table already contains the Phase 4
 * `conversationId` column.
 *
 * The summary backfill must stay runnable both before and after the message
 * table migration, so this check prevents the script from failing on older
 * schemas.
 *
 * @returns {Promise<boolean>} Whether the column exists.
 */
const hasMessageConversationIdColumn = async () => {
  const description = await sequelize.getQueryInterface().describeTable('messages');
  return Boolean(description.conversationId);
};

/**
 * Synchronizes historical message rows with the resolved conversation id.
 *
 * @param {{ conversationId: number, conversationKey: string, transaction: import('sequelize').Transaction }} params
 * @returns {Promise<void>}
 */
const syncMessageConversationIds = async ({
  conversationId,
  conversationKey,
  transaction,
}) => {
  await Message.update(
    { conversationId },
    {
      where: {
        conversationKey,
        [Op.or]: [
          { conversationId: null },
          {
            conversationId: {
              [Op.ne]: conversationId,
            },
          },
        ],
      },
      transaction,
    }
  );
};

/**
 * Creates or refreshes one conversation summary and both participant rows.
 *
 * The operation is intentionally idempotent so it can be re-run after new data
 * imports, partial failures, or future maintenance tasks.
 *
 * @param {{ conversationKey: string, dryRun: boolean, canSyncMessageConversationId: boolean }} params
 * @returns {Promise<{ status: string, conversationKey: string, messageCount?: number }>} Processing result.
 */
const backfillConversation = async ({
  conversationKey,
  dryRun,
  canSyncMessageConversationId,
}) => {
  const { userOneId, userTwoId } = parseConversationKey(conversationKey);

  const latestMessage = await Message.findOne({
    where: { conversationKey },
    order: [
      ['createdAt', 'DESC'],
      ['id', 'DESC'],
    ],
  });

  if (!latestMessage) {
    return {
      status: 'skipped',
      conversationKey,
    };
  }

  if (dryRun) {
    const messageCount = await Message.count({
      where: { conversationKey },
    });

    return {
      status: 'dry-run',
      conversationKey,
      messageCount,
    };
  }

  const transaction = await sequelize.transaction();

  try {
    const [conversation] = await Conversation.findOrCreate({
      where: { directKey: conversationKey },
      defaults: {
        directKey: conversationKey,
        userOneId,
        userTwoId,
      },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });

    await conversation.update(
      {
        userOneId,
        userTwoId,
        lastMessageId: latestMessage.id,
        lastMessageSenderId: latestMessage.senderId,
        lastMessagePreview: buildMessagePreview(latestMessage.message),
        lastMessageAt: latestMessage.createdAt,
      },
      { transaction }
    );

    if (canSyncMessageConversationId) {
      await syncMessageConversationIds({
        conversationId: conversation.id,
        conversationKey,
        transaction,
      });
    }

    const [userOneSummary, userTwoSummary] = await Promise.all([
      buildParticipantSummary({
        conversationId: conversation.id,
        userId: userOneId,
        otherUserId: userTwoId,
        conversationKey,
        latestMessageId: latestMessage.id,
        transaction,
      }),
      buildParticipantSummary({
        conversationId: conversation.id,
        userId: userTwoId,
        otherUserId: userOneId,
        conversationKey,
        latestMessageId: latestMessage.id,
        transaction,
      }),
    ]);

    await ConversationParticipant.upsert(userOneSummary, { transaction });
    await ConversationParticipant.upsert(userTwoSummary, { transaction });

    await transaction.commit();

    return {
      status: 'processed',
      conversationKey,
    };
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
};

/**
 * Ensures the chat summary tables exist before backfilling into them.
 * This keeps the script safe to run independently from the API server startup.
 *
 * @returns {Promise<void>}
 */
const ensureChatSummaryTables = async () => {
  await Conversation.sync();
  await ConversationParticipant.sync();
};

/**
 * Runs the full backfill loop.
 *
 * @returns {Promise<void>}
 */
const main = async () => {
  const options = parseCliArgs(process.argv.slice(2));

  console.log('[CHAT BACKFILL] Starting', options);

  await ensureChatSummaryTables();
  const canSyncMessageConversationId = await hasMessageConversationIdColumn();

  const summary = {
    processed: 0,
    skipped: 0,
    dryRun: 0,
    failed: 0,
  };

  let lastConversationKey = null;
  let hasMore = true;

  while (hasMore) {
    const conversationKeys = await fetchConversationKeysBatch({
      lastConversationKey,
      batchSize: options.batchSize,
      specificConversationKey: options.conversationKey,
    });

    if (!conversationKeys.length) {
      break;
    }

    for (const conversationKey of conversationKeys) {
      try {
        const result = await backfillConversation({
          conversationKey,
          dryRun: options.dryRun,
          canSyncMessageConversationId,
        });

        summary[result.status === 'processed' ? 'processed' : result.status === 'dry-run' ? 'dryRun' : 'skipped'] += 1;

        if (result.status === 'dry-run') {
          console.log(`[CHAT BACKFILL][DRY RUN] ${conversationKey} -> ${result.messageCount} messages`);
        }
      } catch (error) {
        summary.failed += 1;
        console.error(`[CHAT BACKFILL][FAILED] ${conversationKey}`, error.message);
      }
    }

    if (options.conversationKey) {
      hasMore = false;
      continue;
    }

    lastConversationKey = conversationKeys[conversationKeys.length - 1];
    hasMore = conversationKeys.length === options.batchSize;
  }

  console.log('[CHAT BACKFILL] Completed', summary);
};

main()
  .then(async () => {
    await sequelize.close();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error('[CHAT BACKFILL] Fatal error', error);
    await sequelize.close();
    process.exit(1);
  });
