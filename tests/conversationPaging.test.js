const assert = require("node:assert/strict");
const test = require("node:test");
const bcrypt = require("bcryptjs");

const sequelize = require("../config/db");
const User = require("../models/User");
const chatService = require("../services/chatService");
const { deleteUserRecords } = require("../services/userRecordPurge");

/**
 * The app loads a long conversation in pages. The first page (no cursor) must say there are older
 * messages; it used to always report hasMore=false, so the app could not tell a long chat from a short one.
 */

const uniqueSuffix = `${Date.now()}-${process.pid}`;
const createdUserIds = [];

const makeUser = async (label) => {
  const user = await User.create({
    name: `Paging ${label}`,
    email: `paging-${label}-${uniqueSuffix}@test.com`,
    mobile: "0400000002",
    password: await bcrypt.hash("Password123!", 10),
    role: "client",
    provider: "manual",
  });
  createdUserIds.push(user.id);
  return user;
};

test.after(async () => {
  if (createdUserIds.length) {
    await sequelize.transaction((transaction) => deleteUserRecords(createdUserIds, transaction));
  }
  await sequelize.close();
});

test("conversation pages report hasMore correctly in page and cursor mode", async () => {
  const alice = await makeUser("alice");
  const bob = await makeUser("bob");

  for (let i = 1; i <= 5; i += 1) {
    await chatService.sendDirectMessage({
      senderId: alice.id,
      receiverId: bob.id,
      message: `message ${i}`,
    });
  }

  const ask = (options) =>
    chatService.getConversationMessages({
      loggedUserId: alice.id,
      otherUserId: bob.id,
      ...options,
    });

  // Newest 2 of 5: there are older ones.
  const first = await ask({ limit: 2 });
  assert.deepEqual(first.items.map((m) => m.message), ["message 4", "message 5"]);
  assert.equal(first.hasMore, true);
  assert.ok(first.nextCursor);

  // Walking back with the cursor reaches the start, and only then says there is no more.
  const second = await ask({ limit: 2, beforeMessageId: first.items[0].id });
  assert.deepEqual(second.items.map((m) => m.message), ["message 2", "message 3"]);
  assert.equal(second.hasMore, true);

  const third = await ask({ limit: 2, beforeMessageId: second.items[0].id });
  assert.deepEqual(third.items.map((m) => m.message), ["message 1"]);
  assert.equal(third.hasMore, false);

  // A page that holds everything has nothing older.
  const everything = await ask({ limit: 100 });
  assert.equal(everything.items.length, 5);
  assert.equal(everything.hasMore, false);

  // The last offset page also says so.
  const lastPage = await ask({ limit: 2, page: 3 });
  assert.deepEqual(lastPage.items.map((m) => m.message), ["message 1"]);
  assert.equal(lastPage.hasMore, false);
});
