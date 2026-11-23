const assert = require("node:assert/strict");
const test = require("node:test");
const bcrypt = require("bcryptjs");

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";

const sequelize = require("../config/db");
const User = require("../models/User");
const { DeviceToken, saveDeviceToken } = require("../models/deviceTokenModel");
const { removeMyDeviceToken } = require("../controllers/notificationController");
const { deleteUserRecords } = require("../services/userRecordPurge");

const suffix = `${Date.now()}-${process.pid}`;
const createdUserIds = [];
const createdTokens = [];

const makeUser = async (label) => {
  const user = await User.create({
    name: `Token ${label}`,
    email: `devicetoken-${label}-${suffix}@test.com`,
    mobile: "0400000004",
    password: await bcrypt.hash("Password123!", 10),
    role: "client",
    provider: "manual",
  });
  createdUserIds.push(user.id);
  return user;
};

const callRemove = async (userId, body) => {
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  await removeMyDeviceToken({ user: { id: userId }, body }, res);
  return res;
};

test.after(async () => {
  await DeviceToken.destroy({ where: { token: createdTokens } });
  if (createdUserIds.length) {
    await sequelize.transaction((transaction) => deleteUserRecords(createdUserIds, transaction));
  }
  await sequelize.close();
});

test("logout removes the caller's own device token", async () => {
  const user = await makeUser("own");
  const token = `fcm-own-${suffix}`;
  createdTokens.push(token);
  await saveDeviceToken(user.id, token);

  const res = await callRemove(user.id, { token });

  assert.equal(res.statusCode, 200);
  assert.equal(await DeviceToken.count({ where: { token } }), 0);
});

test("logout cannot remove another user's device token", async () => {
  const owner = await makeUser("owner");
  const other = await makeUser("other");
  const token = `fcm-owner-${suffix}`;
  createdTokens.push(token);
  await saveDeviceToken(owner.id, token);

  const res = await callRemove(other.id, { token });

  assert.equal(res.statusCode, 200);
  assert.equal(await DeviceToken.count({ where: { token, user_id: owner.id } }), 1);
});

test("logout succeeds when the token is already gone and rejects a missing token", async () => {
  const user = await makeUser("gone");

  const unknown = await callRemove(user.id, { token: `fcm-unknown-${suffix}` });
  assert.equal(unknown.statusCode, 200);

  const missing = await callRemove(user.id, {});
  assert.equal(missing.statusCode, 400);
});

test("logout leaves the user's other devices registered", async () => {
  const user = await makeUser("multi");
  const phone = `fcm-phone-${suffix}`;
  const tablet = `fcm-tablet-${suffix}`;
  createdTokens.push(phone, tablet);
  await saveDeviceToken(user.id, phone);
  await saveDeviceToken(user.id, tablet);

  await callRemove(user.id, { token: phone });

  assert.equal(await DeviceToken.count({ where: { token: phone } }), 0);
  assert.equal(await DeviceToken.count({ where: { token: tablet } }), 1);
});
