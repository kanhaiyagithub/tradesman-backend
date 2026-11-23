const assert = require("node:assert/strict");
const test = require("node:test");
const bcrypt = require("bcryptjs");

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";

const sequelize = require("../config/db");
const User = require("../models/User");
const chatService = require("../services/chatService");
const { deleteUserRecords } = require("../services/userRecordPurge");

const suffix = `${Date.now()}-${process.pid}`;
const createdUserIds = [];

const makeUser = async (label, role) => {
  const user = await User.create({
    name: `Rules ${label}`,
    email: `chatrules-${label}-${suffix}@test.com`,
    mobile: "0400000003",
    password: await bcrypt.hash("Password123!", 10),
    role,
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

test("chat is client <-> tradesman only, tradesmen reply but cannot cold-message, and no email is exposed", async () => {
  const client = await makeUser("client", "client");
  const otherClient = await makeUser("client2", "client");
  const tradesman = await makeUser("tradesman", "tradesman");

  await assert.rejects(
    chatService.sendDirectMessage({ senderId: client.id, receiverId: otherClient.id, message: "hi" }),
    /cannot message this user/
  );

  await assert.rejects(
    chatService.sendDirectMessage({ senderId: tradesman.id, receiverId: client.id, message: "hello?" }),
    /cannot message this user/
  );

  const first = await chatService.sendDirectMessage({
    senderId: client.id,
    receiverId: tradesman.id,
    message: "Are you free?",
  });
  assert.equal("email" in first.sender, false);
  assert.equal("email" in first.receiver, false);

  const reply = await chatService.sendDirectMessage({
    senderId: tradesman.id,
    receiverId: client.id,
    message: "Yes",
  });
  assert.equal(reply.message, "Yes");
});
