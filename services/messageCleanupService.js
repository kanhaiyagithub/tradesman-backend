const { Op } = require("sequelize");

const Message = require("../models/messageModel");
const Conversation = require("../models/conversationModel");
const ConversationParticipant = require("../models/conversationParticipantModel");
const { withJobLock } = require("./backgroundJobLockService");

/**
 * Deletes chat messages 30 days after they were created.
 *
 * - Hard delete (the Message model is paranoid, so `force: true` is used).
 * - Deletes in small batches so a large backlog never locks the table.
 * - Conversations are kept. Any conversation whose newest message was deleted
 *   gets its "last message" preview cleared and its unread counter reset, so
 *   the chat list never shows or counts a message that no longer exists.
 * - Safe with several instances: guarded by the MySQL named job lock.
 */

const MESSAGE_CLEANUP_LOCK = "tradesman:message-cleanup";
const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_BATCH_SIZE = 1000;
const DEFAULT_MAX_BATCHES = 500;
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const ID_CHUNK_SIZE = 1000;

const getPositiveNumberEnv = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const getRetentionDays = () => getPositiveNumberEnv("MESSAGE_RETENTION_DAYS", DEFAULT_RETENTION_DAYS);

/** Messages created before this moment are due for deletion. */
const getCutoffDate = (now = new Date()) =>
  new Date(now.getTime() - getRetentionDays() * DAY_MS);

/**
 * Clears the preview/unread state of conversations whose newest message is
 * older than the cutoff (so every message in them was just deleted).
 *
 * @returns {Promise<number>} Number of conversations reset.
 */
const resetEmptiedConversations = async (cutoff) => {
  const conversations = await Conversation.findAll({
    where: {
      lastMessageId: { [Op.ne]: null },
      lastMessageAt: { [Op.lt]: cutoff },
    },
    attributes: ["id"],
    raw: true,
  });

  const ids = conversations.map((conversation) => conversation.id);

  for (let index = 0; index < ids.length; index += ID_CHUNK_SIZE) {
    const chunk = ids.slice(index, index + ID_CHUNK_SIZE);

    await Conversation.update(
      { lastMessageId: null, lastMessageSenderId: null, lastMessagePreview: null },
      { where: { id: { [Op.in]: chunk } } }
    );

    await ConversationParticipant.update(
      { unreadCount: 0, lastReadMessageId: null },
      { where: { conversationId: { [Op.in]: chunk } } }
    );
  }

  return ids.length;
};

/**
 * Deletes every message older than the retention window.
 *
 * @param {object} [options]
 * @param {Date} [options.now]
 * @param {boolean} [options.dryRun] - Only count; change nothing.
 * @returns {Promise<{cutoff: Date, deleted: number, conversationsReset: number, dryRun: boolean}>}
 */
const deleteExpiredMessages = async ({ now = new Date(), dryRun = false } = {}) => {
  const cutoff = getCutoffDate(now);
  const where = { createdAt: { [Op.lt]: cutoff } };

  if (dryRun) {
    // paranoid: false so already soft-deleted rows are counted too (they are removed as well).
    const deleted = await Message.count({ where, paranoid: false });
    return { cutoff, deleted, conversationsReset: 0, dryRun: true };
  }

  const batchSize = Math.floor(getPositiveNumberEnv("MESSAGE_CLEANUP_BATCH_SIZE", DEFAULT_BATCH_SIZE));
  const maxBatches = Math.floor(getPositiveNumberEnv("MESSAGE_CLEANUP_MAX_BATCHES", DEFAULT_MAX_BATCHES));
  let deleted = 0;

  for (let batch = 0; batch < maxBatches; batch += 1) {
    const removed = await Message.destroy({ where, limit: batchSize, force: true });
    deleted += removed;

    if (removed < batchSize) break;
  }

  const conversationsReset = deleted > 0 ? await resetEmptiedConversations(cutoff) : 0;

  return { cutoff, deleted, conversationsReset, dryRun: false };
};

/** Lock-guarded run that logs the result and never throws. */
const runMessageCleanup = async (options = {}) => {
  try {
    const lockResult = await withJobLock(MESSAGE_CLEANUP_LOCK, () => deleteExpiredMessages(options));

    if (lockResult.skipped) {
      console.log("[MESSAGE CLEANUP] Skipped", { reason: lockResult.reason });
      return lockResult;
    }

    const { deleted, conversationsReset, cutoff } = lockResult.result;
    if (deleted > 0 || options.dryRun) {
      console.log("[MESSAGE CLEANUP] Completed", {
        deleted,
        conversationsReset,
        cutoff: cutoff.toISOString(),
        dryRun: Boolean(options.dryRun),
      });
    }

    return lockResult.result;
  } catch (error) {
    console.error("[MESSAGE CLEANUP ERROR]", { message: error.message });
    return null;
  }
};

/** Starts the daily cleanup (also runs once at startup). Returns { stop }. */
const startMessageCleanupJob = () => {
  const intervalMs = getPositiveNumberEnv("MESSAGE_CLEANUP_INTERVAL_MS", DEFAULT_INTERVAL_MS);

  runMessageCleanup();

  const timer = setInterval(runMessageCleanup, intervalMs);
  if (typeof timer.unref === "function") timer.unref();

  console.log("[MESSAGE CLEANUP] Job started", {
    retentionDays: getRetentionDays(),
    intervalMs,
  });

  return { stop: () => clearInterval(timer) };
};

module.exports = {
  getCutoffDate,
  getRetentionDays,
  deleteExpiredMessages,
  runMessageCleanup,
  startMessageCleanupJob,
};
