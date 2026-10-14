const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const jwt = require("jsonwebtoken");

// Dead DB + fake secrets BEFORE anything loads config/db or Stripe: nothing here
// can reach a real database or service. Models are stubbed per test.
process.env.DB_HOST = "127.0.0.1";
process.env.DB_PORT = "1";
process.env.DB_NAME = "hardening_test_unused";
process.env.DB_USER = "unused";
process.env.DB_PASS = "unused";
process.env.JWT_SECRET = "test-jwt-secret-not-real";
process.env.STRIPE_SECRET_KEY = "sk_test_fake_not_real";
process.env.META_CAPI_ENABLED = "false";

// Stub push/email senders before the controllers destructure them.
const notificationService = require("../services/notificationService");
const sentNotifications = [];
notificationService.createAndSendNotification = async (...args) => {
  sentNotifications.push(args);
  return { success: true };
};

const User = require("../models/User");
const Review = require("../models/reviewModel");
const Hire = require("../models/hireModel");
const TravelPlan = require("../models/locationModel");
const UserSubscription = require("../models/UserSubscription");
const userController = require("../controllers/userController");
const hireController = require("../controllers/hireController");
const locationController = require("../controllers/locationController");
const clientBookingController = require("../controllers/clientBookingController");
const { verifyToken } = require("../middlewares/authMiddleware");
const socketModule = require("../socket");
const { passwordFingerprint, signRefreshToken } = require("../utils/authTokens");

const saved = {
  userFindAndCountAll: User.findAndCountAll,
  userFindAll: User.findAll,
  userFindOne: User.findOne,
  userFindByPk: User.findByPk,
  reviewFindAll: Review.findAll,
  hireFindAll: Hire.findAll,
  hireFindOne: Hire.findOne,
  hireCreate: Hire.create,
  planFindAll: TravelPlan.findAll,
  subFindOne: UserSubscription.findOne,
  emitToUser: socketModule.emitToUser,
  consoleLog: console.log,
  consoleError: console.error,
};

test.beforeEach(() => {
  console.error = () => {};
});

test.afterEach(() => {
  User.findAndCountAll = saved.userFindAndCountAll;
  User.findAll = saved.userFindAll;
  User.findOne = saved.userFindOne;
  User.findByPk = saved.userFindByPk;
  Review.findAll = saved.reviewFindAll;
  Hire.findAll = saved.hireFindAll;
  Hire.findOne = saved.hireFindOne;
  Hire.create = saved.hireCreate;
  sentNotifications.length = 0;
  TravelPlan.findAll = saved.planFindAll;
  UserSubscription.findOne = saved.subFindOne;
  socketModule.emitToUser = saved.emitToUser;
  console.log = saved.consoleLog;
  console.error = saved.consoleError;
});

const makeRes = () => {
  const response = { statusCode: 200, body: null };
  const res = {
    status(code) {
      response.statusCode = code;
      return this;
    },
    json(body) {
      response.body = body;
      return this;
    },
    send(body) {
      response.body = body;
      return this;
    },
  };
  return { res, response };
};

const SENSITIVE_KEYS = [
  "email",
  "mobile",
  "password",
  "googleId",
  "provider",
  "resetPasswordToken",
  "resetPasswordExpires",
  "licenseNumber",
  "licenseExpiry",
  "licenseDocument",
  "approvedBy",
  "approvedAt",
  "rejectionReason",
  "isApproved",
];

/** True when the key appears anywhere in the (nested) value. */
const containsKey = (value, key) => {
  if (Array.isArray(value)) return value.some((item) => containsKey(item, key));
  if (value && typeof value === "object") {
    return Object.keys(value).some((k) => k === key || containsKey(value[k], key));
  }
  return false;
};

const assertNoSensitiveFields = (payload) => {
  for (const key of SENSITIVE_KEYS) {
    assert.equal(containsKey(payload, key), false, `response must not contain "${key}"`);
  }
};

const dbRow = (json) => ({ ...json, toJSON: () => json });

const tradesmanJson = (overrides = {}) => ({
  id: 5,
  name: "Terry Trade",
  email: "terry@example.com",
  mobile: "0412345678",
  password: "$2a$10$hash",
  googleId: "google-123",
  provider: "google",
  role: "tradesman",
  profileImage: null,
  TradesmanDetail: {
    tradeTypeId: 2,
    tradeType: "Plumber",
    businessName: "Terry Plumbing",
    shortBio: "Fast and tidy",
    licenseNumber: "LIC-1",
    licenseExpiry: "2030-01-01",
    licenseDocument: "doc.jpg",
    isApproved: true,
    approvedBy: 1,
    rejectionReason: null,
  },
  ...overrides,
});

const clientJson = () => ({
  id: 9,
  name: "Cleo Client",
  email: "cleo@example.com",
  mobile: "0400000000",
  password: "$2a$10$hash",
  googleId: "g-9",
  role: "client",
  profileImage: null,
});

// ------------------------------------------------------- A. directory data

test("GET /users and /users/clients require a login", () => {
  const fs = require("node:fs");
  const routes = fs.readFileSync(path.join(__dirname, "../routes/userRoutes.js"), "utf8");

  assert.match(routes, /router\.get\('\/', verifyToken, userController\.getAllUsers\)/);
  assert.match(routes, /router\.get\('\/clients', verifyToken, userController\.getAllClients\)/);
});

test("getAllUsers returns only the public profile shape and does not search email or mobile", async () => {
  let queryOptions;
  User.findAndCountAll = async (options) => {
    queryOptions = options;
    return { count: 2, rows: [dbRow(tradesmanJson()), dbRow(clientJson())] };
  };
  Review.findAll = async () => [{ toUserId: 5, avgRating: "4.5", reviewCount: "2" }];

  const { res, response } = makeRes();
  await userController.getAllUsers({ query: { search: "terry@example.com" } }, res);

  assert.equal(response.statusCode, 200);
  const [tradesman, client] = response.body.data.data;

  assertNoSensitiveFields(response.body);
  assert.deepEqual(Object.keys(client).sort(), ["id", "name", "profileImage", "role"]);
  assert.equal(tradesman.businessName, "Terry Plumbing");
  assert.equal(tradesman.tradeType, "Plumber");
  assert.equal(tradesman.avgRating, 4.5);
  assert.equal(tradesman.reviewCount, 2);
  assert.equal(tradesman.isVerified, true);

  // search matches the name only
  assert.deepEqual(Object.keys(queryOptions.where), ["name"]);
  assert.deepEqual(queryOptions.attributes, ["id", "name", "role", "profileImage"]);
});

test("getAllTradesmen lists approved tradesmen only, with the public shape", async () => {
  let queryOptions;
  User.findAndCountAll = async (options) => {
    queryOptions = options;
    return { count: 1, rows: [dbRow(tradesmanJson())] };
  };
  Review.findAll = async () => [];

  const { res, response } = makeRes();
  await userController.getAllTradesmen({ query: { search: "x", tradeType: "Plumber" } }, res);

  const include = queryOptions.include[0];
  assert.equal(include.where.isApproved, true);
  assert.equal(include.where.tradeType, "Plumber");
  assert.equal(include.required, true, "users without approved details must not be listed");
  assert.deepEqual(Object.keys(queryOptions.where), ["role", "name"]);

  assert.equal(response.statusCode, 200);
  assertNoSensitiveFields(response.body);
  const [item] = response.body.data;
  for (const key of ["id", "name", "profileImage", "tradeType", "businessName", "shortBio", "avgRating", "reviewCount", "isVerified"]) {
    assert.ok(Object.hasOwn(item, key), `missing ${key}`);
  }
  assert.equal(item.avgRating, 0);
});

test("getAllClients returns id, name, role and profileImage only", async () => {
  User.findAndCountAll = async () => ({ count: 1, rows: [dbRow(clientJson())] });

  const { res, response } = makeRes();
  await userController.getAllClients({ query: {} }, res);

  assert.equal(response.statusCode, 200);
  assertNoSensitiveFields(response.body);
  assert.deepEqual(Object.keys(response.body.data.data[0]).sort(), ["id", "name", "profileImage", "role"]);
});

test("getUserById returns the public shape for tradesmen and clients", async () => {
  Review.findAll = async () => [{ toUserId: 5, avgRating: "5.0", reviewCount: "1" }];

  User.findOne = async () => dbRow(tradesmanJson());
  let result = makeRes();
  await userController.getUserById({ params: { id: "5" } }, result.res);
  assertNoSensitiveFields(result.response.body);
  assert.equal(result.response.body.data.avgRating, 5);

  User.findOne = async () => dbRow(clientJson());
  result = makeRes();
  await userController.getUserById({ params: { id: "9" } }, result.res);
  assertNoSensitiveFields(result.response.body);
  assert.deepEqual(Object.keys(result.response.body.data).sort(), ["id", "name", "profileImage", "role"]);
});

// --------------------------------------------------- filter: leak, radius, B6/B7/C16

const runFilter = async (query) => {
  const logs = [];
  console.log = (...args) => logs.push(args);
  const { res, response } = makeRes();
  await userController.filterTradesmen({ method: "GET", query, body: {} }, res);
  return { response, logs };
};

const plan = (overrides = {}) => ({
  id: 70,
  tradesmanId: 5,
  currentLocation: "Perth",
  latitude: -31.9,
  longitude: 115.8,
  destination: "Sydney",
  destinationLatitude: -33.8,
  destinationLongitude: 151.2,
  startDateTime: new Date(Date.now() - 3600 * 1000),
  destinationDateTime: new Date(Date.now() + 86400 * 1000),
  ...overrides,
});

test("filter never returns the raw user row and adds availability and location", async () => {
  User.findAll = async () => [dbRow(tradesmanJson()), dbRow(tradesmanJson({ id: 6, name: "Idle Ivan" }))];
  Review.findAll = async () => [{ toUserId: 5, avgRating: "4.0", reviewCount: "3" }];
  TravelPlan.findAll = async () => [plan()];

  const { response } = await runFilter({});

  assert.equal(response.statusCode, 200);
  assertNoSensitiveFields(response.body);

  const [active, idle] = response.body.data.data;
  assert.equal(active.availability, "available_now");
  assert.equal(active.hasActivePlan, true);
  assert.equal(active.location.current, "Perth");
  assert.equal(active.location.destination, "Sydney");
  assert.equal(active.avgRating, 4);
  assert.equal(idle.availability, "unavailable");
  assert.equal(idle.hasActivePlan, false);
  assert.equal(idle.location, null);
});

test("filter reports an upcoming plan as upcoming", async () => {
  User.findAll = async () => [dbRow(tradesmanJson())];
  Review.findAll = async () => [];
  TravelPlan.findAll = async () =>
    [plan({ startDateTime: new Date(Date.now() + 3600 * 1000) })];

  const { response } = await runFilter({});

  assert.equal(response.body.data.data[0].availability, "upcoming");
});

test("filter prefers a running plan over an upcoming one", async () => {
  User.findAll = async () => [dbRow(tradesmanJson())];
  Review.findAll = async () => [];
  TravelPlan.findAll = async () => [
    plan({ id: 1, startDateTime: new Date(Date.now() - 7200 * 1000), destinationDateTime: new Date(Date.now() + 3600 * 1000) }),
    plan({ id: 2, startDateTime: new Date(Date.now() + 7200 * 1000), destinationDateTime: new Date(Date.now() + 99999 * 1000) }),
  ];

  const { response } = await runFilter({});

  assert.equal(response.body.data.data[0].location.travelPlanId, 1);
  assert.equal(response.body.data.data[0].availability, "available_now");
});

test("filter accepts radiusKm, caps it, and rejects invalid values", async () => {
  User.findAll = async () => [];

  assert.equal((await runFilter({})).response.body.data.radiusKm, 15);
  assert.equal((await runFilter({ radiusKm: "40" })).response.body.data.radiusKm, 40);
  assert.equal((await runFilter({ radiusKm: "5000" })).response.body.data.radiusKm, 100);

  for (const bad of ["abc", "0", "-5"]) {
    assert.equal((await runFilter({ radiusKm: bad })).response.statusCode, 400, `radiusKm=${bad}`);
  }
});

test("filter radius is actually used to include or exclude stops", async () => {
  // One stop in Perth; the requested point is ~45 km away.
  const travelPlan = {
    id: 3,
    allowStops: true,
    stops: [{ name: "Perth stop", latitude: -31.95, longitude: 115.86 }],
  };

  User.findAll = async () => [dbRow(tradesmanJson({ travelPlans: [travelPlan] }))];
  Review.findAll = async () => [];
  TravelPlan.findAll = async () => [];

  const query = { latitude: "-31.55", longitude: "115.9" };
  const narrow = await runFilter({ ...query });
  const wide = await runFilter({ ...query, radiusKm: "60" });

  assert.equal(narrow.response.body.data.radiusKm, 15);
  assert.equal(narrow.response.body.data.count, 0, "stop is outside the default 15 km radius");
  assert.equal(wide.response.body.data.radiusKm, 60);
  assert.equal(wide.response.body.data.count, 1, "stop is inside a 60 km radius");
  assert.ok(wide.response.body.data.data[0].matchedDistanceKm > 15);
});

// ----------------------------------- filter: auth, route points, order, paging, login codes

test("the filter endpoints require a login", () => {
  const fs = require("node:fs");
  const routes = fs.readFileSync(path.join(__dirname, "../routes/userRoutes.js"), "utf8");

  assert.match(routes, /router\.get\('\/tradesmen\/filter', verifyToken, userController\.filterTradesmen\)/);
  assert.match(routes, /router\.post\('\/tradesmen\/filter', verifyToken, userController\.filterTradesmen\)/);
});

const routePlan = (overrides = {}) => ({
  id: 3,
  allowStops: false,
  stops: [],
  currentLocation: "Perth",
  latitude: -31.95,
  longitude: 115.86,
  destination: "Sydney",
  destinationLatitude: -33.87,
  destinationLongitude: 151.21,
  startDateTime: new Date(Date.now() - 3600 * 1000),
  destinationDateTime: new Date(Date.now() + 86400 * 1000),
  ...overrides,
});

test("location search matches a plan's current position and destination, not only stops", async () => {
  // A plan with NO stops (the common case).
  User.findAll = async () => [dbRow(tradesmanJson({ travelPlans: [routePlan()] }))];
  Review.findAll = async () => [];
  TravelPlan.findAll = async () => [];

  const nearCurrent = await runFilter({ latitude: "-31.9", longitude: "115.8" });
  assert.equal(nearCurrent.response.body.data.count, 1, "near the current position (Perth)");
  assert.equal(nearCurrent.response.body.data.data[0].matchedStop.name, "Perth");
  assert.ok(nearCurrent.response.body.data.data[0].matchedDistanceKm < 15);

  const nearDestination = await runFilter({ latitude: "-33.8", longitude: "151.2" });
  assert.equal(nearDestination.response.body.data.count, 1, "near the destination (Sydney)");
  assert.equal(nearDestination.response.body.data.data[0].matchedStop.name, "Sydney");

  const farAway = await runFilter({ latitude: "-37.8", longitude: "144.9" });
  assert.equal(farAway.response.body.data.count, 0, "Melbourne is far from both points");
});

test("a plan without coordinates never matches a location search", async () => {
  const noCoordinates = routePlan({
    latitude: null,
    longitude: null,
    destinationLatitude: null,
    destinationLongitude: null,
  });

  User.findAll = async () => [dbRow(tradesmanJson({ travelPlans: [noCoordinates] }))];
  Review.findAll = async () => [];
  TravelPlan.findAll = async () => [];

  // (0, 0) must not match just because a missing coordinate became 0.
  const { response } = await runFilter({ latitude: "0", longitude: "0", radiusKm: "100" });
  assert.equal(response.body.data.count, 0);
});

test("location search returns the nearest tradesman first", async () => {
  // ~11 km and 0 km from the searched point, both inside the default 15 km radius.
  const farther = routePlan({ id: 1, latitude: -31.8, longitude: 115.8 });
  const nearer = routePlan({ id: 2, latitude: -31.9, longitude: 115.8 });

  User.findAll = async () => [
    dbRow(tradesmanJson({ id: 21, name: "Farther Fred", travelPlans: [farther] })),
    dbRow(tradesmanJson({ id: 22, name: "Nearer Nina", travelPlans: [nearer] })),
  ];
  Review.findAll = async () => [];
  TravelPlan.findAll = async () => [];

  const { response } = await runFilter({ latitude: "-31.9", longitude: "115.8" });
  const names = response.body.data.data.map((item) => item.name);

  assert.deepEqual(names, ["Nearer Nina", "Farther Fred"]);
});

const fiveTradesmen = () =>
  Array.from({ length: 5 }, (_, i) =>
    dbRow(tradesmanJson({ id: 30 + i, name: `Tradesman ${i + 1}` })),
  );

test("filter paginates with page and limit, and reports totals", async () => {
  User.findAll = async () => fiveTradesmen();
  Review.findAll = async () => [];
  TravelPlan.findAll = async () => [];

  const first = (await runFilter({ limit: "2", page: "1" })).response.body.data;
  assert.equal(first.count, 2);
  assert.equal(first.total, 5);
  assert.deepEqual(first.pagination, { total: 5, page: 1, limit: 2, totalPages: 3, hasMore: true });
  assert.deepEqual(first.data.map((i) => i.name), ["Tradesman 1", "Tradesman 2"]);

  const last = (await runFilter({ limit: "2", page: "3" })).response.body.data;
  assert.equal(last.count, 1);
  assert.equal(last.pagination.hasMore, false);
  assert.deepEqual(last.data.map((i) => i.name), ["Tradesman 5"]);

  const beyond = (await runFilter({ limit: "2", page: "9" })).response.body.data;
  assert.equal(beyond.count, 0);
  assert.equal(beyond.total, 5);
});

test("filter without limit still returns everything (older clients)", async () => {
  User.findAll = async () => fiveTradesmen();
  Review.findAll = async () => [];
  TravelPlan.findAll = async () => [];

  const { data } = (await runFilter({})).response.body;
  assert.equal(data.count, 5);
  assert.equal(data.total, 5);
  assert.equal(data.pagination, undefined);
});

test("filter caps limit at 100 and rejects invalid page or limit", async () => {
  User.findAll = async () => fiveTradesmen();
  Review.findAll = async () => [];
  TravelPlan.findAll = async () => [];

  const capped = (await runFilter({ limit: "500" })).response.body.data;
  assert.equal(capped.pagination.limit, 100);

  for (const query of [{ limit: "0" }, { limit: "-3" }, { limit: "abc" }, { limit: "2.5" }, { limit: "2", page: "0" }, { limit: "2", page: "x" }]) {
    assert.equal((await runFilter(query)).response.statusCode, 400, JSON.stringify(query));
  }
});

test("availability is looked up only for the returned page", async () => {
  User.findAll = async () => fiveTradesmen();
  Review.findAll = async () => [];
  let requestedIds;
  TravelPlan.findAll = async (options) => {
    requestedIds = options.where.tradesmanId[Object.getOwnPropertySymbols(options.where.tradesmanId)[0]];
    return [];
  };

  await runFilter({ limit: "2", page: "2" });

  assert.deepEqual(requestedIds, [32, 33]);
});

test("login failures carry a code the app can rely on", async () => {
  const bcrypt = require("bcryptjs");
  const hash = bcrypt.hashSync("right-password", 4);
  const login = async (user, body) => {
    User.findOne = async () => user;
    const { res, response } = makeRes();
    await userController.login({ body }, res);
    return response;
  };

  const unknown = await login(null, { email: "nobody@example.com", password: "x" });
  assert.equal(unknown.statusCode, 400);
  assert.equal(unknown.body.code, "INVALID_CREDENTIALS");

  const google = await login(
    { id: 1, email: "g@example.com", password: null },
    { email: "g@example.com", password: "x" },
  );
  assert.equal(google.statusCode, 400);
  assert.equal(google.body.code, "GOOGLE_ACCOUNT");

  const wrong = await login(
    { id: 2, email: "w@example.com", password: hash, role: "client", name: "W" },
    { email: "w@example.com", password: "wrong-password" },
  );
  assert.equal(wrong.statusCode, 400);
  assert.equal(wrong.body.code, "INVALID_CREDENTIALS");

  // The password-vs-Google distinction is the only thing that differs.
  assert.equal(unknown.body.message, wrong.body.message);
});

test("filter does not log request data", async () => {
  User.findAll = async () => [];

  const { logs } = await runFilter({ latitude: "-31.123456", longitude: "115.654321", secretQuery: "do-not-log" });

  const logged = JSON.stringify(logs);
  assert.equal(logged.includes("do-not-log"), false);
  assert.equal(logged.includes("-31.123456"), false);
  assert.equal(logged.includes("FILTER TRADESMEN HIT"), false);
});

// ----------------------------------------------------- B8/B9 client bookings

const hireRow = (id, status, tradesmanId = 5) => ({
  id,
  tradesmanId,
  status,
  jobDescription: `job ${id}`,
  createdAt: new Date("2026-10-01T00:00:00Z"),
  tradesman: { toJSON: () => ({ id: tradesmanId, name: "Terry", profileImage: null }), profileImage: null },
});

test("bookings type=past includes completed, rejected and cancelled; type=all has no status filter", async () => {
  const wheres = [];
  Hire.findAll = async (options) => {
    wheres.push(options.where);
    return [];
  };
  Review.findAll = async () => [];

  for (const type of ["past", "all", "my"]) {
    await clientBookingController.getClientBookings({ user: { id: 9 }, query: { type } }, makeRes().res);
  }

  const statusSymbols = (where) => {
    const status = where.status;
    return status ? Object.getOwnPropertySymbols(status).map((s) => status[s])[0] : null;
  };

  assert.deepEqual(statusSymbols(wheres[0]), ["completed", "rejected", "cancelled"]);
  assert.equal(wheres[1].status, undefined);
  assert.deepEqual(statusSymbols(wheres[2]), ["pending", "accepted"]);
});

test("bookings include my review, tradesman rating and a correct canReview", async () => {
  Hire.findAll = async () => [hireRow(1, "completed"), hireRow(2, "completed"), hireRow(3, "cancelled")];
  Review.findAll = async (options) => {
    // First call: this client's reviews. Second call: grouped ratings.
    if (options.group) return [{ toUserId: 5, avgRating: "4.5", reviewCount: "2" }];
    return [{ id: 11, hireId: 1, rating: 5, comment: "Great", createdAt: new Date("2026-10-02T00:00:00Z") }];
  };

  const { res, response } = makeRes();
  await clientBookingController.getClientBookings({ user: { id: 9 }, query: { type: "past" } }, res);

  const [reviewed, unreviewed, cancelled] = response.body.data;
  assert.equal(reviewed.myReview.rating, 5);
  assert.equal(reviewed.myReview.comment, "Great");
  assert.equal(reviewed.canReview, false);
  assert.equal(unreviewed.myReview, null);
  assert.equal(unreviewed.canReview, true);
  assert.equal(cancelled.canReview, false);
  assert.deepEqual(reviewed.tradesmanRating, { avgRating: 4.5, reviewCount: 2 });
});

// ---------------------------------------------------- B10 real-time events

const hireModelRow = (overrides = {}) => ({
  id: 40,
  clientId: 9,
  tradesmanId: 5,
  status: "pending",
  requestCompletion: false,
  save: async function save() {},
  ...overrides,
});

const captureEmits = () => {
  const emitted = [];
  socketModule.emitToUser = (userId, eventName, payload) => emitted.push({ userId, eventName, payload });
  return emitted;
};

test("responding to a hire emits hire-updated to both users", async () => {
  const emitted = captureEmits();
  const hire = hireModelRow();
  Hire.findOne = async () => hire;
  User.findByPk = async () => ({ name: "Terry" });

  const { res, response } = makeRes();
  await hireController.respondHire(
    { user: { id: 5, role: "tradesman" }, body: { hireId: 40, action: "accept" } },
    res
  );

  assert.equal(response.statusCode, 200);
  assert.deepEqual(
    emitted.map((e) => [e.userId, e.eventName]).sort(),
    [[5, "hire-updated"], [9, "hire-updated"]]
  );
  assert.equal(emitted[0].payload.status, "accepted");
  assert.equal(emitted[0].payload.reason, "accepted");
});

test("requesting completion emits hire-updated and completion-requested to both users", async () => {
  const emitted = captureEmits();
  Hire.findOne = async () => hireModelRow({ status: "accepted" });
  User.findByPk = async () => ({ name: "Terry" });

  const { res } = makeRes();
  await hireController.requestJobCompletion(
    { user: { id: 5, role: "tradesman" }, body: { hireId: 40 } },
    res
  );

  const names = emitted.map((e) => e.eventName);
  assert.equal(names.filter((n) => n === "hire-updated").length, 2);
  assert.equal(names.filter((n) => n === "completion-requested").length, 2);
  assert.equal(emitted[0].payload.requestCompletion, true);
});

test("confirming and cancelling emit events; rejecting completion emits hire-updated", async () => {
  User.findByPk = async () => ({ name: "Cleo" });

  let emitted = captureEmits();
  Hire.findOne = async () => hireModelRow({ status: "accepted", requestCompletion: true });
  await hireController.confirmJobCompletion(
    { user: { id: 9, role: "client" }, body: { hireId: 40, confirm: true } },
    makeRes().res
  );
  assert.deepEqual(
    [...new Set(emitted.map((e) => e.eventName))].sort(),
    ["hire-updated", "job-completed"]
  );
  assert.equal(emitted[0].payload.status, "completed");

  emitted = captureEmits();
  Hire.findOne = async () => hireModelRow({ status: "accepted", requestCompletion: true });
  await hireController.confirmJobCompletion(
    { user: { id: 9, role: "client" }, body: { hireId: 40, confirm: false } },
    makeRes().res
  );
  assert.deepEqual([...new Set(emitted.map((e) => e.eventName))], ["hire-updated"]);
  assert.equal(emitted[0].payload.reason, "completion_rejected");

  emitted = captureEmits();
  Hire.findByPk = async () => hireModelRow({ status: "accepted" });
  await hireController.cancelHire(
    { user: { id: 9, role: "client" }, body: { hireId: 40 } },
    makeRes().res
  );
  assert.equal(emitted.length, 2);
  assert.equal(emitted[0].payload.status, "cancelled");
});

// ------------------------------------------------ hire request: optional description

const stubHireRequest = () => {
  const created = [];
  User.findOne = async () => ({ id: 5, role: "tradesman" });
  Hire.findOne = async () => null;
  User.findByPk = async () => ({ name: "Cara Client" });
  Hire.create = async (values) => {
    created.push(values);
    return { id: 77, requestCompletion: false, ...values };
  };
  return created;
};

test("a hire request needs no description and the notification has no placeholder", async () => {
  captureEmits();
  const created = stubHireRequest();

  const { res, response } = makeRes();
  await hireController.requestHire(
    { user: { id: 9, role: "client" }, body: { tradesmanId: 5 } },
    res,
  );

  assert.equal(response.statusCode, 201);
  assert.equal(created[0].jobDescription, null);

  const [userId, title, body] = sentNotifications[0];
  assert.equal(userId, 5);
  assert.equal(title, "New Job Request");
  assert.equal(body, "Cara Client has sent you a hire request.");
});

test("a blank description is treated as no description", async () => {
  captureEmits();
  const created = stubHireRequest();

  const { res, response } = makeRes();
  await hireController.requestHire(
    { user: { id: 9, role: "client" }, body: { tradesmanId: 5, jobDescription: "   " } },
    res,
  );

  assert.equal(response.statusCode, 201);
  assert.equal(created[0].jobDescription, null);
  assert.doesNotMatch(sentNotifications[0][2], /for:/);
});

test("a description that is sent is still stored and shown", async () => {
  captureEmits();
  const created = stubHireRequest();

  const { res, response } = makeRes();
  await hireController.requestHire(
    { user: { id: 9, role: "client" }, body: { tradesmanId: 5, jobDescription: "Fix the sink" } },
    res,
  );

  assert.equal(response.statusCode, 201);
  assert.equal(created[0].jobDescription, "Fix the sink");
  assert.equal(sentNotifications[0][2], "Cara Client wants to hire you for: Fix the sink");
});

test("a description over 2000 characters is still rejected", async () => {
  stubHireRequest();

  const { res, response } = makeRes();
  await hireController.requestHire(
    { user: { id: 9, role: "client" }, body: { tradesmanId: 5, jobDescription: "x".repeat(2001) } },
    res,
  );

  assert.equal(response.statusCode, 400);
  assert.match(response.body.message, /2000 characters/);
});

test("a socket failure never fails the hire request", async () => {
  socketModule.emitToUser = () => {
    throw new Error("socket exploded");
  };
  Hire.findOne = async () => hireModelRow();
  User.findByPk = async () => ({ name: "Terry" });

  const { res, response } = makeRes();
  await hireController.respondHire(
    { user: { id: 5, role: "tradesman" }, body: { hireId: 40, action: "reject" } },
    res
  );

  assert.equal(response.statusCode, 200);
});

// -------------------------------------------------- B12 / C14 token handling

const runVerifyToken = (authorization) => {
  const { res, response } = makeRes();
  let nextCalled = false;
  verifyToken({ headers: authorization ? { authorization } : {} }, res, () => {
    nextCalled = true;
  });
  return { response, nextCalled };
};

test("auth failures return one consistent 401 body with a code", () => {
  const missing = runVerifyToken(null);
  assert.equal(missing.response.statusCode, 401);
  assert.equal(missing.response.body.code, "TOKEN_MISSING");
  assert.equal(missing.response.body.success, false);

  const expiredToken = jwt.sign({ id: 1, role: "client" }, process.env.JWT_SECRET, { expiresIn: -10 });
  const expired = runVerifyToken(`Bearer ${expiredToken}`);
  assert.equal(expired.response.statusCode, 401);
  assert.equal(expired.response.body.code, "TOKEN_EXPIRED");
  assert.equal(expired.response.body.success, false);

  const invalid = runVerifyToken("Bearer not-a-real-token");
  assert.equal(invalid.response.statusCode, 401);
  assert.equal(invalid.response.body.code, "TOKEN_INVALID");

  const wrongSecret = runVerifyToken(`Bearer ${jwt.sign({ id: 1 }, "another-secret")}`);
  assert.equal(wrongSecret.response.body.code, "TOKEN_INVALID");

  for (const result of [missing, expired, invalid, wrongSecret]) {
    assert.deepEqual(Object.keys(result.response.body).sort(), ["code", "message", "success"]);
    assert.equal(result.nextCalled, false);
  }
});

test("a valid access token passes and a refresh token is rejected as an access token", () => {
  const access = jwt.sign({ id: 1, role: "client" }, process.env.JWT_SECRET, { expiresIn: "1h" });
  const ok = runVerifyToken(`Bearer ${access}`);
  assert.equal(ok.nextCalled, true);

  const refresh = signRefreshToken({ id: 1, password: "hash" });
  const rejected = runVerifyToken(`Bearer ${refresh}`);
  assert.equal(rejected.nextCalled, false);
  assert.equal(rejected.response.statusCode, 401);
  assert.equal(rejected.response.body.code, "TOKEN_INVALID");
});

test("a refresh token can be exchanged for new tokens", async () => {
  const user = { id: 3, name: "Sam", email: "sam@example.com", role: "client", password: "hash-1" };
  User.findByPk = async () => user;

  const { res, response } = makeRes();
  await userController.refreshToken({ body: { refreshToken: signRefreshToken(user) } }, res);

  assert.equal(response.statusCode, 200);
  const { token, refreshToken } = response.body.data;
  const decodedAccess = jwt.verify(token, process.env.JWT_SECRET);
  assert.equal(decodedAccess.id, 3);
  assert.equal(decodedAccess.type, undefined);
  assert.equal(jwt.verify(refreshToken, process.env.JWT_SECRET).type, "refresh");
  assert.equal(response.body.data.user.email, "sam@example.com");
});

test("refresh fails for an expired token, an access token, junk, or after a password change", async () => {
  const user = { id: 3, name: "Sam", email: "s@example.com", role: "client", password: "hash-1" };
  User.findByPk = async () => user;

  const attempt = async (refreshToken) => {
    const { res, response } = makeRes();
    await userController.refreshToken({ body: { refreshToken } }, res);
    return response;
  };

  const expired = jwt.sign({ id: 3, type: "refresh", pv: passwordFingerprint(user) }, process.env.JWT_SECRET, { expiresIn: -10 });
  let response = await attempt(expired);
  assert.equal(response.statusCode, 401);
  assert.equal(response.body.code, "TOKEN_EXPIRED");

  const access = jwt.sign({ id: 3, role: "client" }, process.env.JWT_SECRET, { expiresIn: "1h" });
  response = await attempt(access);
  assert.equal(response.statusCode, 401);
  assert.equal(response.body.code, "TOKEN_INVALID");

  response = await attempt("junk");
  assert.equal(response.statusCode, 401);

  response = await attempt(undefined);
  assert.equal(response.statusCode, 400);

  const valid = signRefreshToken(user);
  user.password = "hash-2-after-password-change";
  response = await attempt(valid);
  assert.equal(response.statusCode, 401);
  assert.equal(response.body.code, "TOKEN_INVALID");

  User.findByPk = async () => null;
  response = await attempt(signRefreshToken({ id: 3, password: "hash-2-after-password-change" }));
  assert.equal(response.statusCode, 401);
});

// ------------------------------------------------------------ C15 plan fields

test("createTravelPlan names the missing fields", async () => {
  UserSubscription.findOne = async () => ({ plan: { name: "Basic", maxSharedLocations: 2 } });

  const { res, response } = makeRes();
  await locationController.createTravelPlan(
    {
      user: { id: 5, role: "tradesman" },
      body: { startLocation: "Perth", latitude: 1, longitude: 2 },
    },
    res
  );

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.body.data.missingFields, [
    "destination",
    "startDateTime",
    "destinationDateTime",
    "destinationLatitude",
    "destinationLongitude",
  ]);
  assert.match(response.body.message, /destination, startDateTime/);
});

// -------------------------------------------------------------- A5 session secret

test("the app refuses to start without SESSION_SECRET", () => {
  const appPath = path.join(__dirname, "../app.js");
  const env = { ...process.env };
  delete env.SESSION_SECRET;

  // cwd is a temp dir so dotenv cannot load the project's .env.
  const result = spawnSync(process.execPath, ["-e", "require(process.argv[1])", appPath], {
    cwd: os.tmpdir(),
    env,
    encoding: "utf8",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SESSION_SECRET is required/);
});

test("app.js no longer contains a default session secret", () => {
  const fs = require("node:fs");
  const source = fs.readFileSync(path.join(__dirname, "../app.js"), "utf8");

  assert.equal(source.includes("your_secret_key"), false);
});
