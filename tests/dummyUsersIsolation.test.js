const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";

const app = require("../app");
const sequelize = require("../config/db");
const User = require("../models/User");
const Hire = require("../models/hireModel");
const Message = require("../models/messageModel");
const Conversation = require("../models/conversationModel");
const ConversationParticipant = require("../models/conversationParticipantModel");
const Notification = require("../models/notificationModel");
const TradesmanDetails = require("../models/TradesmanDetails");
const TradesType = require("../models/tradesTypeModel");
const TravelPlan = require("../models/locationModel");
const ClientTradeAlert = require("../models/clientTradeAlertModel");
const TravelPlanAlertMatch = require("../models/travelPlanAlertMatchModel");
const EmailNotificationLog = require("../models/EmailNotificationLog");
const {
  matchTravelPlanWithAlerts,
  matchClientTradeAlertWithTravelPlans,
} = require("../services/travelAlertService");
const { inSameWorld } = require("../services/dummyWorld");

const suffix = `${Date.now()}-${process.pid}`;
const TAG = `iso${Date.now().toString(36)}`;

let server;
let baseUrl;
let trade; // a throwaway trade type, so matching can only ever involve this test's own accounts
const people = {}; // realClient, realTradesman, dummyClient, dummyTradesman
const userIds = [];
const planIds = [];
const alertIds = [];

const tokenFor = (user) =>
  jwt.sign({ id: user.id, email: user.email, role: user.role }, process.env.JWT_SECRET, { expiresIn: "1h" });

const call = async (method, path, { as, body } = {}) => {
  const headers = { "Content-Type": "application/json" };
  if (as) headers.Authorization = `Bearer ${as}`;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed, text };
};

const makeUser = async (label, role, isDummy) => {
  const user = await User.create({
    name: `${TAG} ${label}`,
    email: `${TAG}-${label}-${suffix}@test.com`,
    mobile: "0411111111",
    password: await bcrypt.hash("Password123!", 10),
    role,
    provider: "manual",
    isVerified: true,
    isDummy,
  });
  userIds.push(user.id);
  user.token = tokenFor(user);

  if (role === "tradesman") {
    await TradesmanDetails.create({
      userId: user.id,
      tradeType: trade.name,
      tradeTypeId: trade.id,
      businessName: `${TAG} ${label} Co`,
      shortBio: "bio",
      licenseNumber: "L-1",
      licenseExpiry: new Date("2031-01-01"),
      isApproved: true,
      verificationStatus: "approved",
    });
  }
  return user;
};

const day = 24 * 3600 * 1000;
const makePlan = async (tradesman) => {
  const plan = await TravelPlan.create({
    tradesmanId: tradesman.id,
    latitude: -10.0,
    longitude: 100.0,
    startLocation: `${TAG} start`,
    startDateTime: new Date(Date.now() + day),
    destination: `${TAG} end`,
    destinationLatitude: -10.5,
    destinationLongitude: 100.5,
    destinationDateTime: new Date(Date.now() + 3 * day),
    allowStops: false,
    status: "open",
  });
  planIds.push(plan.id);
  return plan;
};

const makeAlert = async (client) => {
  const alert = await ClientTradeAlert.create({
    clientId: client.id,
    tradeType: trade.name,
    tradeTypeId: trade.id,
    locationName: `${TAG} alert`,
    latitude: -10.0,
    longitude: 100.0,
    radiusKm: 50,
    isActive: true,
  });
  alertIds.push(alert.id);
  return alert;
};

const names = (body) => JSON.stringify(body);

test.before(async () => {
  await sequelize.authenticate();
  trade = await TradesType.create({ name: `${TAG} Trade`, category: "Test", isActive: true });

  people.realClient = await makeUser("real-client", "client", false);
  people.realTradesman = await makeUser("real-tradesman", "tradesman", false);
  people.dummyClient = await makeUser("dummy-client", "client", true);
  people.dummyTradesman = await makeUser("dummy-tradesman", "tradesman", true);

  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));

  const matches = await TravelPlanAlertMatch.findAll({ where: { clientTradeAlertId: alertIds } });
  await EmailNotificationLog.destroy({ where: { matchId: matches.map((m) => m.id) } }).catch(() => {});
  await TravelPlanAlertMatch.destroy({ where: { clientTradeAlertId: alertIds } });
  await ClientTradeAlert.destroy({ where: { id: alertIds } });
  await TravelPlan.destroy({ where: { id: planIds } });
  await Hire.destroy({ where: { clientId: userIds } });
  const participants = await ConversationParticipant.findAll({ where: { userId: userIds } });
  const conversationIds = [...new Set(participants.map((p) => p.conversationId))];
  await Message.destroy({ where: { senderId: userIds }, force: true }); // messages are soft-deleted by default
  await ConversationParticipant.destroy({ where: { userId: userIds } });
  await Conversation.destroy({ where: { id: conversationIds } });
  await Notification.destroy({ where: { userId: userIds } });
  await TradesmanDetails.destroy({ where: { userId: userIds } });
  await User.destroy({ where: { id: userIds } });
  await TradesType.destroy({ where: { id: trade.id } });
  await sequelize.close();
});

/* ---------- looking people up ---------- */

test("the tradesman list shows each world only its own tradesmen (anonymous callers count as real)", async () => {
  const { realTradesman, dummyTradesman, realClient, dummyClient } = people;
  const path = `/api/users/tradesmen?search=${TAG}`;

  const anonymous = await call("GET", path);
  assert.equal(anonymous.status, 200);
  assert.ok(names(anonymous.body).includes("real-tradesman"));
  assert.ok(!names(anonymous.body).includes("dummy-tradesman"));

  const asReal = await call("GET", path, { as: realClient.token });
  assert.ok(names(asReal.body).includes("real-tradesman"));
  assert.ok(!names(asReal.body).includes("dummy-tradesman"));

  const asDummy = await call("GET", path, { as: dummyClient.token });
  assert.equal(asDummy.status, 200);
  assert.ok(names(asDummy.body).includes("dummy-tradesman"));
  assert.ok(!names(asDummy.body).includes("real-tradesman"));

  // An admin token sees both (admins manage test users too).
  const adminToken = jwt.sign({ id: 999999, role: "admin" }, process.env.JWT_SECRET);
  const asAdmin = await call("GET", path, { as: adminToken });
  assert.ok(names(asAdmin.body).includes("real-tradesman") && names(asAdmin.body).includes("dummy-tradesman"));
  assert.ok(realTradesman && dummyTradesman);
});

test("a user from the other world is simply 'not found' by id and by profile", async () => {
  const { realTradesman, dummyTradesman, realClient, dummyClient } = people;

  for (const route of ["/api/users", "/api/users/profile"]) {
    assert.equal((await call("GET", `${route}/${realTradesman.id}`, { as: realClient.token })).status, 200, `${route} same world (real)`);
    assert.equal((await call("GET", `${route}/${dummyTradesman.id}`, { as: dummyClient.token })).status, 200, `${route} same world (test)`);
    assert.equal((await call("GET", `${route}/${dummyTradesman.id}`, { as: realClient.token })).status, 404, `${route} real -> test`);
    assert.equal((await call("GET", `${route}/${realTradesman.id}`, { as: dummyClient.token })).status, 404, `${route} test -> real`);
    assert.equal((await call("GET", `${route}/${dummyTradesman.id}`)).status, 404, `${route} anonymous -> test`);
  }
});

test("user and client directories are separated by world", async () => {
  const { realClient, dummyClient, realTradesman, dummyTradesman } = people;

  const realUsers = await call("GET", `/api/users?search=${TAG}&limit=50`, { as: realClient.token });
  assert.ok(names(realUsers.body).includes("real-client") && names(realUsers.body).includes("real-tradesman"));
  assert.ok(!names(realUsers.body).includes("dummy-"));

  const dummyUsers = await call("GET", `/api/users?search=${TAG}&limit=50`, { as: dummyClient.token });
  assert.ok(names(dummyUsers.body).includes("dummy-client") && names(dummyUsers.body).includes("dummy-tradesman"));
  assert.ok(!names(dummyUsers.body).includes("real-"));

  const realClients = await call("GET", `/api/users/clients?search=${TAG}`, { as: realTradesman.token });
  assert.ok(names(realClients.body).includes("real-client"));
  assert.ok(!names(realClients.body).includes("dummy-client"));

  const dummyClients = await call("GET", `/api/users/clients?search=${TAG}`, { as: dummyTradesman.token });
  assert.ok(names(dummyClients.body).includes("dummy-client"));
  assert.ok(!names(dummyClients.body).includes("real-client"));
});

test("a tradesman can only open the profile of a client from their own world", async () => {
  const { realTradesman, dummyTradesman, realClient, dummyClient } = people;
  const profile = (me, client) => call("GET", `/api/users/clients/${client.id}/profile`, { as: me.token });

  // This endpoint also needs an existing hire/chat connection, so create one inside each world.
  const hires = await Hire.bulkCreate([
    { clientId: realClient.id, tradesmanId: realTradesman.id, status: "pending", requestCompletion: false },
    { clientId: dummyClient.id, tradesmanId: dummyTradesman.id, status: "pending", requestCompletion: false },
  ]);

  try {
    assert.equal((await profile(realTradesman, realClient)).status, 200);
    assert.equal((await profile(dummyTradesman, dummyClient)).status, 200);
    // Across worlds the client does not exist as far as the tradesman can tell.
    assert.equal((await profile(realTradesman, dummyClient)).status, 404);
    assert.equal((await profile(dummyTradesman, realClient)).status, 404);
  } finally {
    await Hire.destroy({ where: { id: hires.map((hire) => hire.id) } });
  }
});

test("a client can only open the location profile of a tradesman from their own world", async () => {
  const { realTradesman, dummyTradesman, realClient, dummyClient } = people;
  const view = (me, tradesman) => call("GET", `/api/locations/tradesman/${tradesman.id}`, { as: me.token });

  assert.equal((await view(realClient, realTradesman)).status, 200);
  assert.equal((await view(dummyClient, dummyTradesman)).status, 200);
  assert.equal((await view(realClient, dummyTradesman)).status, 404);
  assert.equal((await view(dummyClient, realTradesman)).status, 404);
});

test("the tradesman filter (client home screen) never mixes worlds", async () => {
  const { realClient, dummyClient } = people;

  const asReal = await call("GET", `/api/users/tradesmen/filter?tradeTypeId=${trade.id}`, { as: realClient.token });
  assert.equal(asReal.status, 200);
  assert.ok(!names(asReal.body).includes("dummy-tradesman"), "a real client must not see test tradesmen");

  const asDummy = await call("GET", `/api/users/tradesmen/filter?tradeTypeId=${trade.id}`, { as: dummyClient.token });
  assert.equal(asDummy.status, 200);
  assert.ok(!names(asDummy.body).includes("real-tradesman"), "a test client must not see real tradesmen");
});

/* ---------- acting on people ---------- */

test("hire requests only work inside one world", async () => {
  const { realClient, dummyClient, realTradesman, dummyTradesman } = people;
  const hire = (me, tradesman) =>
    call("POST", "/api/hire/request", { as: me.token, body: { tradesmanId: tradesman.id } });

  assert.equal((await hire(realClient, dummyTradesman)).status, 400, "real client -> test tradesman");
  assert.equal((await hire(dummyClient, realTradesman)).status, 400, "test client -> real tradesman");
  assert.equal((await hire(realClient, realTradesman)).status, 201, "real -> real");
  assert.equal((await hire(dummyClient, dummyTradesman)).status, 201, "test -> test");

  assert.equal(await Hire.count({ where: { clientId: realClient.id, tradesmanId: dummyTradesman.id } }), 0);
  assert.equal(await Hire.count({ where: { clientId: dummyClient.id, tradesmanId: realTradesman.id } }), 0);
});

test("chat messages only work inside one world (HTTP)", async () => {
  const { realClient, dummyClient, realTradesman, dummyTradesman } = people;
  const send = (me, to) =>
    call("POST", "/api/chat/send", { as: me.token, body: { receiverId: to.id, message: "hello" } });

  const crossed = await send(realClient, dummyTradesman);
  assert.equal(crossed.status, 404);
  assert.match(crossed.body.message, /receiver not found/i);
  assert.equal((await send(dummyClient, realTradesman)).status, 404);
  assert.equal((await send(dummyTradesman, realClient)).status, 404);

  assert.equal((await send(realClient, realTradesman)).status, 201);
  assert.equal((await send(dummyClient, dummyTradesman)).status, 201);

  assert.equal(await Message.count({ where: { senderId: realClient.id, receiverId: dummyTradesman.id } }), 0);
});

/* ---------- travel-alert matching ---------- */

test("alert and travel-plan matching never creates a match across worlds", async () => {
  const { realClient, dummyClient, realTradesman, dummyTradesman } = people;

  const realAlert = await makeAlert(realClient);
  const dummyAlert = await makeAlert(dummyClient);

  // A TEST tradesman's route passes both clients' alerts, but only the TEST client may match.
  const dummyPlan = await makePlan(dummyTradesman);
  const fromPlan = await matchTravelPlanWithAlerts(dummyPlan);
  assert.equal(fromPlan.created, 1, "exactly one match: the test client");
  assert.equal(await TravelPlanAlertMatch.count({ where: { travelPlanId: dummyPlan.id, clientTradeAlertId: dummyAlert.id } }), 1);
  assert.equal(await TravelPlanAlertMatch.count({ where: { travelPlanId: dummyPlan.id, clientTradeAlertId: realAlert.id } }), 0);

  // A REAL tradesman's route matches only the REAL client.
  const realPlan = await makePlan(realTradesman);
  const fromRealPlan = await matchTravelPlanWithAlerts(realPlan);
  assert.equal(fromRealPlan.created, 1, "exactly one match: the real client");
  assert.equal(await TravelPlanAlertMatch.count({ where: { travelPlanId: realPlan.id, clientTradeAlertId: realAlert.id } }), 1);
  assert.equal(await TravelPlanAlertMatch.count({ where: { travelPlanId: realPlan.id, clientTradeAlertId: dummyAlert.id } }), 0);

  // The other direction (a new alert looking for existing plans) obeys the same rule.
  await TravelPlanAlertMatch.destroy({ where: { clientTradeAlertId: [realAlert.id, dummyAlert.id] } });
  await matchClientTradeAlertWithTravelPlans(realAlert);
  await matchClientTradeAlertWithTravelPlans(dummyAlert);
  const matches = await TravelPlanAlertMatch.findAll({ where: { clientTradeAlertId: [realAlert.id, dummyAlert.id] } });
  const pairs = matches.map((m) => `${m.clientId}->${m.tradesmanId}`).sort();
  assert.deepEqual(pairs, [`${realClient.id}->${realTradesman.id}`, `${dummyClient.id}->${dummyTradesman.id}`].sort());
});

test("inSameWorld compares two users and treats unknown ids as different", async () => {
  const { realClient, dummyClient, realTradesman, dummyTradesman } = people;
  assert.equal(await inSameWorld(realClient.id, realTradesman.id), true);
  assert.equal(await inSameWorld(dummyClient.id, dummyTradesman.id), true);
  assert.equal(await inSameWorld(realClient.id, dummyClient.id), false);
  assert.equal(await inSameWorld(realClient.id, 999999999), false);
  assert.equal(await inSameWorld(realClient.id, "abc"), false);
});
