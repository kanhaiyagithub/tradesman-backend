const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const test = require("node:test");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Op } = require("sequelize");

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
process.env.DUMMY_USERS_ENABLED = "true";
process.env.DUMMY_USERS_MAX = "50";

const app = require("../app");
const sequelize = require("../config/db");
const storageConfig = require("../config/storage");
const Admin = require("../models/AdminModel/adminModel");
const User = require("../models/User");
const TradesmanDetails = require("../models/TradesmanDetails");
const TradesType = require("../models/tradesTypeModel");
const SubscriptionPlan = require("../models/SubscriptionPlan");
const UserSubscription = require("../models/UserSubscription");
const TravelPlan = require("../models/locationModel");
const ClientTradeAlert = require("../models/clientTradeAlertModel");
const TravelPlanAlertMatch = require("../models/travelPlanAlertMatchModel");
const LiveProximityNotification = require("../models/LiveProximityNotification");
const TradesmanLiveLocation = require("../models/TradesmanLiveLocation");
const Hire = require("../models/hireModel");
const Review = require("../models/reviewModel");
const Message = require("../models/messageModel");
const Conversation = require("../models/conversationModel");
const ConversationParticipant = require("../models/conversationParticipantModel");
const Notification = require("../models/notificationModel");
const EmailNotificationLog = require("../models/EmailNotificationLog");
const MetaUserAttribution = require("../models/MetaUserAttribution");
const MetaConversionEvent = require("../models/MetaConversionEvent");
const chatService = require("../services/chatService");
const storageService = require("../services/storage/storageService");
const { resetRateLimitBuckets } = require("../middlewares/rateLimitMiddleware");
const { createDummyUsers, parseCreateInput } = require("../services/dummyUserService");
const { purgeDummyUsers } = require("../services/dummyUserPurgeService");

const suffix = `${Date.now()}-${process.pid}`;
const TAG = `del${Date.now().toString(36)}`;
const ADMIN_PASSWORD = "Password123!";
const AT = { latitude: -22.0, longitude: 122.0, label: `${TAG} Town` };

let server;
let baseUrl;
let admin;
let token;
let trade;
let tempPlan = null;
let realClient;
let realTradesman;
const world = {}; // the test users: dt1, dt2 (tradesmen), dc1, dc2 (clients)
const keptRealUserIds = [];

const call = async (method, urlPath, { body, as = token } = {}) => {
  resetRateLimitBuckets();
  const response = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: { "Content-Type": "application/json", ...(as ? { Authorization: `Bearer ${as}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed };
};

const remove = (idOrNull, password = ADMIN_PASSWORD) =>
  idOrNull === null
    ? call("DELETE", "/api/admin/dummy-users", { body: { adminPassword: password } })
    : call("DELETE", `/api/admin/dummy-users/${idOrNull}`, { body: { adminPassword: password } });

const rootDir = () => path.resolve(storageConfig.local.rootDir);
const onDisk = (key) => fs.existsSync(path.join(rootDir(), key));
const photoKeys = (details) =>
  typeof details.portfolioPhotos === "string" ? JSON.parse(details.portfolioPhotos) : details.portfolioPhotos || [];

const filesOf = async (userId) => {
  const user = await User.findByPk(userId, { attributes: ["profileImage"] });
  const details = await TradesmanDetails.findOne({ where: { userId } });
  return [user?.profileImage, details?.licenseDocument, ...(details ? photoKeys(details) : [])].filter(Boolean);
};

/** How many rows anywhere still mention these users. Zero means nothing was left behind. */
const leftoverRows = async (ids) => {
  const raw = async (table, column) => {
    const [rows] = await sequelize.query(`SELECT COUNT(*) AS n FROM \`${table}\` WHERE \`${column}\` IN (:ids)`, { replacements: { ids } });
    return Number(rows[0].n);
  };
  const counts = {
    users: await User.count({ where: { id: ids } }),
    details: await TradesmanDetails.count({ where: { userId: ids } }),
    subscriptions: await UserSubscription.count({ where: { userId: ids } }),
    plans: await TravelPlan.count({ where: { tradesmanId: ids } }),
    alerts: await ClientTradeAlert.count({ where: { clientId: ids } }),
    matches: await TravelPlanAlertMatch.count({ where: { [Op.or]: [{ tradesmanId: ids }, { clientId: ids }] } }),
    proximity: await LiveProximityNotification.count({ where: { [Op.or]: [{ tradesmanId: ids }, { clientId: ids }] } }),
    liveLocation: await TradesmanLiveLocation.count({ where: { tradesmanId: ids } }),
    hires: await Hire.count({ where: { [Op.or]: [{ clientId: ids }, { tradesmanId: ids }] } }),
    reviews: await Review.count({ where: { [Op.or]: [{ fromUserId: ids }, { toUserId: ids }] } }),
    messages: await Message.count({ where: { [Op.or]: [{ senderId: ids }, { receiverId: ids }] }, paranoid: false }),
    participants: await ConversationParticipant.count({ where: { [Op.or]: [{ userId: ids }, { otherUserId: ids }] } }),
    conversations: await Conversation.count({ where: { [Op.or]: [{ userOneId: ids }, { userTwoId: ids }] } }),
    notifications: await Notification.count({ where: { userId: ids } }),
    emailLogs: await EmailNotificationLog.count({ where: { [Op.or]: [{ recipientUserId: ids }, { clientId: ids }, { tradesmanId: ids }] } }),
    metaAttribution: await MetaUserAttribution.count({ where: { userId: ids } }),
    metaEvents: await MetaConversionEvent.count({ where: { userId: ids } }),
    deviceTokens: await raw("device_tokens", "user_id"),
    portfolioPhotos: await raw("portfoliophotos", "userId"),
  };
  return Object.fromEntries(Object.entries(counts).filter(([, count]) => count > 0));
};

/** Gives one test user a row in every table that can mention a user, so deletion has something to find. */
const seedEverythingFor = async (tradesman, client) => {
  const plan = await TravelPlan.findOne({ where: { tradesmanId: tradesman.id } });
  const alert = await ClientTradeAlert.create({
    clientId: client.id, tradeType: trade.name, tradeTypeId: trade.id, locationName: `${TAG} extra`,
    latitude: AT.latitude, longitude: AT.longitude, radiusKm: 30, isActive: true,
  });

  await chatService.sendDirectMessage({ senderId: client.id, receiverId: tradesman.id, message: "hi from test" });
  const hire = await Hire.create({ clientId: client.id, tradesmanId: tradesman.id, status: "pending", requestCompletion: false });
  await Review.create({ hireId: hire.id, fromUserId: client.id, toUserId: tradesman.id, rating: 5, role: "client" });
  await Notification.create({ userId: tradesman.id, title: "t", body: "b", expiresAt: new Date(Date.now() + 864e5) });
  await sequelize.query("INSERT INTO device_tokens (user_id, token) VALUES (:id, :token)", { replacements: { id: tradesman.id, token: `${TAG}-${tradesman.id}-${suffix}` } });
  await sequelize.query("INSERT INTO portfoliophotos (userId, image, createdAt, updatedAt) VALUES (:id, 'portfolio/legacy.png', NOW(), NOW())", { replacements: { id: tradesman.id } });
  await EmailNotificationLog.create({ type: "TEST_LOG", recipientEmail: client.email, recipientUserId: client.id, clientId: client.id, tradesmanId: tradesman.id, status: "sent" });
  await LiveProximityNotification.create({ tradesmanId: tradesman.id, travelPlanId: plan.id, clientId: client.id, clientTradeAlertId: alert.id, lastNotifiedAt: new Date() });
  await TradesmanLiveLocation.create({ tradesmanId: tradesman.id, travelPlanId: plan.id, latitude: AT.latitude, longitude: AT.longitude });
  await MetaUserAttribution.create({ userId: tradesman.id });
  await MetaConversionEvent.create({ eventId: `${TAG}-${tradesman.id}-${suffix}`, eventName: "CompleteRegistration", userId: tradesman.id });
};

const makeUsers = async (fields) =>
  (await createDummyUsers({
    adminId: admin.id,
    input: parseCreateInput({ tradeTypeId: trade.id, location: AT, runMatching: true, ...fields }),
  })).created;

test.before(async () => {
  await sequelize.authenticate();
  assert.equal(await User.count({ where: { isDummy: true } }), 0, "start from a database without test users");

  admin = await Admin.create({
    name: "Delete Admin",
    email: `delete-admin-${suffix}@test.com`,
    password: await bcrypt.hash(ADMIN_PASSWORD, 10),
  });
  token = jwt.sign({ id: admin.id, role: "admin" }, process.env.JWT_SECRET, { expiresIn: "1h" });

  trade = await TradesType.create({ name: `${TAG} Trade`, category: "Test", isActive: true, licenceRequired: true });
  if ((await SubscriptionPlan.count()) === 0) {
    tempPlan = await SubscriptionPlan.create({ name: `${TAG} Plan`, priceMonthly: 5, stripePriceId: `price_${TAG}_${suffix}` });
  }

  // Real users with real data: none of this may ever be touched.
  const realPasswordHash = await bcrypt.hash("Password123!", 10);
  const mk = (label, role) =>
    User.create({
      name: `${TAG} real ${label}`, email: `${TAG}-${label}-${suffix}@test.com`, mobile: "0411111111",
      password: realPasswordHash, role, provider: "manual", isVerified: true,
    });
  realClient = await mk("client", "client");
  realTradesman = await mk("tradesman", "tradesman");
  keptRealUserIds.push(realClient.id, realTradesman.id);
  await chatService.sendDirectMessage({ senderId: realClient.id, receiverId: realTradesman.id, message: "real chat" });
  await Hire.create({ clientId: realClient.id, tradesmanId: realTradesman.id, status: "pending", requestCompletion: false });
  await Notification.create({ userId: realClient.id, title: "real", body: "real", expiresAt: new Date(Date.now() + 864e5) });
  await ClientTradeAlert.create({
    clientId: realClient.id, tradeType: trade.name, tradeTypeId: trade.id, locationName: `${TAG} real alert`,
    latitude: AT.latitude, longitude: AT.longitude, radiusKm: 30, isActive: true,
  });

  const [dt1, dt2] = await makeUsers({ role: "tradesman", count: 2 });
  const [dc1, dc2] = await makeUsers({ role: "client", count: 2, createAlert: true });
  Object.assign(world, { dt1, dt2, dc1, dc2 });

  await seedEverythingFor(dt1, dc1);
  await seedEverythingFor(dt2, dc2);
  // A chat between a user who will be deleted and one who will stay: it must go.
  await chatService.sendDirectMessage({ senderId: dc2.id, receiverId: dt1.id, message: "cross chat" });

  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));

  await purgeDummyUsers().catch(() => {}); // whatever a failing test left behind

  const ids = keptRealUserIds;
  const alertIds = (await ClientTradeAlert.findAll({ where: { clientId: ids } })).map((a) => a.id);
  await TravelPlanAlertMatch.destroy({ where: { clientTradeAlertId: alertIds } });
  await ClientTradeAlert.destroy({ where: { id: alertIds } });
  await Hire.destroy({ where: { clientId: ids } });
  const participants = await ConversationParticipant.findAll({ where: { userId: ids } });
  const conversationIds = [...new Set(participants.map((p) => p.conversationId))];
  await Message.destroy({ where: { senderId: ids }, force: true });
  await ConversationParticipant.destroy({ where: { userId: ids } });
  await Conversation.destroy({ where: { id: conversationIds } });
  await Notification.destroy({ where: { userId: ids } });
  await User.destroy({ where: { id: ids } });
  await TradesType.destroy({ where: { id: trade.id } });
  if (tempPlan) await SubscriptionPlan.destroy({ where: { id: tempPlan.id } });
  await Admin.destroy({ where: { id: admin.id } });
  await sequelize.close();
});

/* ---------- safeguards ---------- */

test("deleting needs an admin token and the acting admin's own password", async () => {
  assert.equal((await call("DELETE", `/api/admin/dummy-users/${world.dt1.id}`, { as: null })).status, 401);
  assert.equal((await call("DELETE", "/api/admin/dummy-users", { as: null })).status, 401);

  const missing = await call("DELETE", `/api/admin/dummy-users/${world.dt1.id}`, { body: {} });
  assert.equal(missing.status, 400);
  const wrong = await remove(world.dt1.id, "nope-nope");
  assert.equal(wrong.status, 400);
  assert.match(wrong.body.message, /incorrect password/i);
  assert.equal((await call("DELETE", "/api/admin/dummy-users", { body: { adminPassword: "nope-nope" } })).status, 400);

  assert.equal(await User.count({ where: { isDummy: true } }), 4, "nothing was deleted");
});

test("a real user can never be deleted here, and bad ids are refused", async () => {
  const real = await remove(realClient.id);
  assert.equal(real.status, 404);
  assert.match(real.body.message, /test user not found/i);
  assert.ok(await User.findByPk(realClient.id));

  assert.equal((await remove(999999999)).status, 404);
  assert.equal((await call("DELETE", "/api/admin/dummy-users/abc", { body: { adminPassword: ADMIN_PASSWORD } })).status, 400);

  // The service itself also refuses a mix of test and real ids, and deletes nothing at all.
  await assert.rejects(purgeDummyUsers({ ids: [world.dt1.id, realClient.id] }), /Test user not found/);
  assert.ok(await User.findByPk(world.dt1.id));
  assert.ok(await User.findByPk(realClient.id));
});

test("a test user with a real Stripe subscription is refused, not orphaned", async () => {
  const sub = await UserSubscription.findOne({ where: { userId: world.dt2.id } });
  await sub.update({ stripeSubscriptionId: `sub_${TAG}_${suffix}` });
  try {
    const response = await remove(world.dt2.id);
    assert.equal(response.status, 409);
    assert.match(response.body.message, /stripe/i);
    assert.ok(await User.findByPk(world.dt2.id));
  } finally {
    await sub.update({ stripeSubscriptionId: null });
  }
});

test("if the delete fails part-way, nothing is removed (database or files)", async () => {
  const ids = [world.dt1.id, world.dc1.id];
  const files = await filesOf(world.dt1.id);
  const before = await leftoverRows(ids);
  assert.ok(Object.keys(before).length >= 10, "the seeded users really do own rows in many tables");

  const original = User.destroy;
  User.destroy = async () => {
    throw new Error("simulated failure at the last step");
  };
  try {
    const response = await remove(world.dt1.id);
    assert.equal(response.status, 500);
    assert.doesNotMatch(JSON.stringify(response.body), /simulated/, "no internals in the answer");
  } finally {
    User.destroy = original;
  }

  assert.deepEqual(await leftoverRows(ids), before, "the whole transaction was rolled back");
  for (const key of files) assert.ok(onDisk(key), `${key} must still exist`);
});

/* ---------- deleting one ---------- */

test("deleting one test tradesman removes everything they own, and only theirs", async () => {
  const { dt1, dt2, dc1, dc2 } = world;
  const dt1Files = await filesOf(dt1.id);
  const dt2Files = await filesOf(dt2.id);
  assert.ok(dt1Files.length >= 4 && dt1Files.every(onDisk));

  const dt2Before = await leftoverRows([dt2.id]);
  const dc1Before = await User.findByPk(dc1.id);

  const response = await remove(dt1.id);
  assert.equal(response.status, 200);
  assert.equal(response.body.data.deleted, 1);
  assert.ok(response.body.data.filesRemoved >= 4);

  // Nothing at all still mentions the deleted user (hires, reviews, chats and the cross chat included).
  assert.deepEqual(await leftoverRows([dt1.id]), {});
  for (const key of dt1Files) assert.equal(onDisk(key), false, `${key} should be gone`);

  // Other test users are intact, including their own data and files.
  assert.ok(dc1Before && (await User.findByPk(dc1.id)), "the client who hired them stays");
  assert.ok(await User.findByPk(dc2.id));
  assert.deepEqual(await leftoverRows([dt2.id]), dt2Before, "another tradesman's data is untouched");
  for (const key of dt2Files) assert.ok(onDisk(key), `${key} must stay`);

  // The deleted account cannot log in any more.
  const login = await call("POST", "/api/users/login", { as: null, body: { email: dt1.email, password: dt1.password } });
  assert.equal(login.status, 400);
});

test("real users and their data are untouched by deleting test users", async () => {
  assert.ok(await User.findByPk(realClient.id));
  assert.ok(await User.findByPk(realTradesman.id));
  assert.equal(await Message.count({ where: { senderId: realClient.id, receiverId: realTradesman.id } }), 1);
  assert.equal(await Hire.count({ where: { clientId: realClient.id, tradesmanId: realTradesman.id } }), 1);
  assert.equal(await Notification.count({ where: { userId: realClient.id } }), 1);
  assert.equal(await ClientTradeAlert.count({ where: { clientId: realClient.id } }), 1);
});

test("listing and deleting still work when creating test users is switched off", async () => {
  process.env.DUMMY_USERS_ENABLED = "false";
  try {
    assert.equal((await call("GET", "/api/admin/dummy-users")).status, 200, "the list is still readable");
    const create = await call("POST", "/api/admin/dummy-users", { body: { adminPassword: ADMIN_PASSWORD, role: "client" } });
    assert.equal(create.status, 403, "but nothing new can be created");

    const removed = await remove(world.dc2.id);
    assert.equal(removed.status, 200, "test data can always be cleaned up");
    assert.deepEqual(await leftoverRows([world.dc2.id]), {});
  } finally {
    process.env.DUMMY_USERS_ENABLED = "true";
  }
});

/* ---------- deleting all ---------- */

test("delete all removes every test user and file, and no real user", async () => {
  const remaining = (await User.findAll({ where: { isDummy: true }, attributes: ["id"] })).map((u) => u.id);
  assert.ok(remaining.length >= 2);
  const files = (await Promise.all(remaining.map(filesOf))).flat();
  assert.ok(files.length >= 4 && files.every(onDisk));

  const response = await remove(null);
  assert.equal(response.status, 200);
  assert.equal(response.body.data.deleted, remaining.length);

  assert.equal(await User.count({ where: { isDummy: true } }), 0);
  assert.deepEqual(await leftoverRows(remaining), {}, "not one row anywhere still mentions them");
  for (const key of files) assert.equal(onDisk(key), false, `${key} should be gone`);

  // Real data still there.
  assert.ok(await User.findByPk(realClient.id));
  assert.equal(await Message.count({ where: { senderId: realClient.id } }), 1);

  // Nothing left to delete: a harmless no-op.
  const again = await remove(null);
  assert.equal(again.status, 200);
  assert.equal(again.body.data.deleted, 0);

  const status = await call("GET", "/api/admin/dummy-users/status");
  assert.equal(status.body.data.count, 0);
});
