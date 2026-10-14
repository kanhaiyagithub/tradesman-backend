const assert = require("node:assert/strict");
const test = require("node:test");
const { Op } = require("sequelize");

// Dead DB BEFORE anything loads config/db: nothing here can reach a real database.
process.env.DB_HOST = "127.0.0.1";
process.env.DB_PORT = "1";
process.env.DB_NAME = "message_cleanup_test_unused";
process.env.DB_USER = "unused";
process.env.DB_PASS = "unused";

// The job lock uses MySQL GET_LOCK; replace it before the service destructures it.
const lockService = require("../services/backgroundJobLockService");
let lockSkipped = false;
lockService.withJobLock = async (name, task) =>
  lockSkipped ? { skipped: true, reason: "LOCK_NOT_ACQUIRED" } : { skipped: false, result: await task() };

const Message = require("../models/messageModel");
const Conversation = require("../models/conversationModel");
const ConversationParticipant = require("../models/conversationParticipantModel");
const cleanup = require("../services/messageCleanupService");

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-14T12:00:00Z");
const daysAgo = (days) => new Date(NOW.getTime() - days * DAY);

const saved = {
  destroy: Message.destroy,
  count: Message.count,
  convFindAll: Conversation.findAll,
  convUpdate: Conversation.update,
  partUpdate: ConversationParticipant.update,
  consoleLog: console.log,
  consoleError: console.error,
};

let messages;
let destroyCalls;
let conversationUpdates;
let participantUpdates;
let conversationRows;

test.beforeEach(() => {
  delete process.env.MESSAGE_RETENTION_DAYS;
  delete process.env.MESSAGE_CLEANUP_BATCH_SIZE;
  delete process.env.MESSAGE_CLEANUP_MAX_BATCHES;
  lockSkipped = false;
  destroyCalls = [];
  conversationUpdates = [];
  participantUpdates = [];
  conversationRows = [];
  messages = [];
  console.log = () => {};
  console.error = () => {};

  // In-memory messages table honouring where.createdAt < cutoff, limit and force.
  Message.destroy = async ({ where, limit, force }) => {
    destroyCalls.push({ where, limit, force });
    const cutoff = where.createdAt[Op.lt];
    const matching = messages.filter((message) => message.createdAt < cutoff).slice(0, limit);
    matching.forEach((message) => messages.splice(messages.indexOf(message), 1));
    return matching.length;
  };
  Message.count = async ({ where, paranoid }) => {
    assert.equal(paranoid, false);
    return messages.filter((message) => message.createdAt < where.createdAt[Op.lt]).length;
  };

  Conversation.findAll = async () => conversationRows;
  Conversation.update = async (values, { where }) => {
    conversationUpdates.push({ values, ids: where.id[Op.in] });
    return [where.id[Op.in].length];
  };
  ConversationParticipant.update = async (values, { where }) => {
    participantUpdates.push({ values, ids: where.conversationId[Op.in] });
    return [1];
  };
});

test.afterEach(() => {
  Message.destroy = saved.destroy;
  Message.count = saved.count;
  Conversation.findAll = saved.convFindAll;
  Conversation.update = saved.convUpdate;
  ConversationParticipant.update = saved.partUpdate;
  console.log = saved.consoleLog;
  console.error = saved.consoleError;
});

const addMessages = (...ages) =>
  ages.forEach((age, index) => messages.push({ id: index + 1, createdAt: daysAgo(age) }));

test("the cutoff is 30 days before now by default and follows MESSAGE_RETENTION_DAYS", () => {
  assert.equal(cleanup.getCutoffDate(NOW).getTime(), daysAgo(30).getTime());

  process.env.MESSAGE_RETENTION_DAYS = "7";
  assert.equal(cleanup.getCutoffDate(NOW).getTime(), daysAgo(7).getTime());

  process.env.MESSAGE_RETENTION_DAYS = "nonsense";
  assert.equal(cleanup.getRetentionDays(), 30);
});

test("messages older than 30 days are hard-deleted; newer ones are kept", async () => {
  addMessages(45, 31, 30.5, 29.9, 29, 1, 0);

  const result = await cleanup.deleteExpiredMessages({ now: NOW });

  assert.equal(result.deleted, 3);
  assert.deepEqual(messages.map((message) => message.id).sort(), [4, 5, 6, 7]);
  assert.equal(destroyCalls[0].force, true, "must hard delete, not soft delete");
  assert.equal(destroyCalls[0].where.createdAt[Op.lt].getTime(), daysAgo(30).getTime());
});

test("a backlog is deleted in batches until nothing is left", async () => {
  process.env.MESSAGE_CLEANUP_BATCH_SIZE = "10";
  addMessages(...Array.from({ length: 25 }, () => 40), 5);

  const result = await cleanup.deleteExpiredMessages({ now: NOW });

  assert.equal(result.deleted, 25);
  assert.deepEqual(destroyCalls.map((call) => call.limit), [10, 10, 10]);
  assert.equal(messages.length, 1);
});

test("one run stops at MESSAGE_CLEANUP_MAX_BATCHES and the next run continues", async () => {
  process.env.MESSAGE_CLEANUP_BATCH_SIZE = "10";
  process.env.MESSAGE_CLEANUP_MAX_BATCHES = "2";
  addMessages(...Array.from({ length: 35 }, () => 40));

  const first = await cleanup.deleteExpiredMessages({ now: NOW });
  assert.equal(first.deleted, 20);
  assert.equal(messages.length, 15);

  const second = await cleanup.deleteExpiredMessages({ now: NOW });
  assert.equal(second.deleted, 15);
  assert.equal(messages.length, 0);
});

test("conversations whose newest message expired lose their preview and unread count", async () => {
  addMessages(40);
  conversationRows = [{ id: 7 }, { id: 8 }];

  const result = await cleanup.deleteExpiredMessages({ now: NOW });

  assert.equal(result.conversationsReset, 2);
  assert.deepEqual(conversationUpdates, [
    {
      values: { lastMessageId: null, lastMessageSenderId: null, lastMessagePreview: null },
      ids: [7, 8],
    },
  ]);
  assert.deepEqual(participantUpdates, [
    { values: { unreadCount: 0, lastReadMessageId: null }, ids: [7, 8] },
  ]);
});

test("conversations are only selected when their newest message is older than the cutoff", async () => {
  addMessages(40);
  let selection;
  Conversation.findAll = async (options) => {
    selection = options.where;
    return [];
  };

  await cleanup.deleteExpiredMessages({ now: NOW });

  assert.equal(selection.lastMessageAt[Op.lt].getTime(), daysAgo(30).getTime());
  assert.ok(selection.lastMessageId[Op.ne] === null);
});

test("nothing is touched when no message has expired", async () => {
  addMessages(29, 1);

  const result = await cleanup.deleteExpiredMessages({ now: NOW });

  assert.equal(result.deleted, 0);
  assert.equal(result.conversationsReset, 0);
  assert.equal(conversationUpdates.length, 0);
  assert.equal(participantUpdates.length, 0);
  assert.equal(messages.length, 2);
});

test("a dry run only counts", async () => {
  addMessages(60, 31, 2);

  const result = await cleanup.deleteExpiredMessages({ now: NOW, dryRun: true });

  assert.equal(result.deleted, 2);
  assert.equal(result.dryRun, true);
  assert.equal(destroyCalls.length, 0);
  assert.equal(messages.length, 3);
});

test("a failing database never throws out of the scheduled run", async () => {
  Message.destroy = async () => {
    throw new Error("database is down");
  };

  const result = await cleanup.runMessageCleanup({ now: NOW });

  assert.equal(result, null);
});

test("a run is skipped when another instance holds the lock", async () => {
  lockSkipped = true;
  addMessages(40);

  const result = await cleanup.runMessageCleanup({ now: NOW });

  assert.equal(result.skipped, true);
  assert.equal(messages.length, 1);
});

test("the job starts and stops cleanly", async () => {
  const job = cleanup.startMessageCleanupJob();
  assert.equal(typeof job.stop, "function");
  job.stop();
  await new Promise((resolve) => setImmediate(resolve));
});
