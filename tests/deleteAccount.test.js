const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const bcrypt = require("bcryptjs");

const sequelize = require("../config/db");
const storageConfig = require("../config/storage");
const User = require("../models/User");
const TradesmanDetails = require("../models/TradesmanDetails");
const TradesType = require("../models/tradesTypeModel");
const SubscriptionPlan = require("../models/SubscriptionPlan");
const UserSubscription = require("../models/UserSubscription");
const Hire = require("../models/hireModel");
const Notification = require("../models/notificationModel");
const { createNotification } = require("../services/notificationService");
const { deleteUserAccount } = require("../services/accountDeletionService");

/**
 * Regression test for: DELETE /api/users/:id failing with ER_ROW_IS_REFERENCED_2 because
 * user_subscriptions (and other tables) hold a foreign key to Users without ON DELETE CASCADE.
 */

const uniqueSuffix = `${Date.now()}-${process.pid}`;
const createdUserIds = [];

const makeUser = async (label, role) => {
  const user = await User.create({
    name: `Delete ${label}`,
    email: `delete-account-${label}-${uniqueSuffix}@test.com`,
    mobile: "0400000001",
    password: await bcrypt.hash("Password123!", 10),
    role,
    provider: "manual",
  });
  createdUserIds.push(user.id);
  return user;
};

const writeUpload = async (category, name) => {
  const dir = path.join(storageConfig.local.rootDir, category);
  await fs.promises.mkdir(dir, { recursive: true });
  const full = path.join(dir, name);
  await fs.promises.writeFile(full, "x");
  return { key: `${category}/${name}`, full };
};

test.after(async () => {
  await Notification.destroy({ where: { userId: createdUserIds } });
  await Hire.destroy({ where: { clientId: createdUserIds } });
  await Hire.destroy({ where: { tradesmanId: createdUserIds } });
  await UserSubscription.destroy({ where: { userId: createdUserIds } });
  await TradesmanDetails.destroy({ where: { userId: createdUserIds } });
  await User.destroy({ where: { id: createdUserIds } });
  await sequelize.close();
});

test("deleting a user with a subscription, hire and notification works and keeps other users", async () => {
  const trade = await TradesType.findOne();
  const plan = await SubscriptionPlan.findOne();
  assert.ok(trade && plan, "trade type and subscription plan seeds are required");

  const tradesman = await makeUser("tradesman", "tradesman");
  const client = await makeUser("client", "client");

  const profile = await writeUpload("profile", `profile-delete-${uniqueSuffix}.jpg`);
  const licence = await writeUpload("license", `license-delete-${uniqueSuffix}.jpg`);
  const portfolio = await writeUpload("portfolio", `portfolio-delete-${uniqueSuffix}.jpg`);

  await tradesman.update({ profileImage: profile.key });
  await TradesmanDetails.create({
    userId: tradesman.id,
    tradeType: trade.name,
    tradeTypeId: trade.id,
    licenseDocument: licence.key,
    portfolioPhotos: [portfolio.key],
  });
  await UserSubscription.create({ userId: tradesman.id, planId: plan.id, status: "active" });
  await Hire.create({ clientId: client.id, tradesmanId: tradesman.id, jobDescription: "delete test" });
  await createNotification({ userId: tradesman.id, title: "Hello", body: "Delete test" });

  const result = await deleteUserAccount(tradesman);

  assert.equal(await User.findByPk(tradesman.id), null);
  assert.equal(await UserSubscription.count({ where: { userId: tradesman.id } }), 0);
  assert.equal(await TradesmanDetails.count({ where: { userId: tradesman.id } }), 0);
  assert.equal(await Notification.count({ where: { userId: tradesman.id } }), 0);
  assert.equal(await Hire.count({ where: { tradesmanId: tradesman.id } }), 0);

  // The other side of the hire is a different person and must survive.
  assert.ok(await User.findByPk(client.id));

  // Uploaded files are removed only after the database delete succeeded.
  assert.equal(result.filesRemoved, 3);
  for (const file of [profile, licence, portfolio]) {
    assert.ok(!fs.existsSync(file.full), `${file.key} should be gone`);
  }
});

test("a failed delete leaves the account and its files untouched", async () => {
  const client = await makeUser("rollback", "client");
  const upload = await writeUpload("profile", `profile-rollback-${uniqueSuffix}.jpg`);
  await client.update({ profileImage: upload.key });

  // Force the transaction to fail after files were gathered.
  const original = sequelize.transaction;
  sequelize.transaction = async () => {
    throw new Error("simulated database failure");
  };

  try {
    await assert.rejects(() => deleteUserAccount(client), /simulated database failure/);
  } finally {
    sequelize.transaction = original;
  }

  assert.ok(await User.findByPk(client.id), "the user must still exist");
  assert.ok(fs.existsSync(upload.full), "the upload must not be deleted when the database delete failed");
  await fs.promises.rm(upload.full, { force: true });
});
