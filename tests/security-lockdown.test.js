const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const bcrypt = require("bcryptjs");
const { Op } = require("sequelize");

process.env.CORS_ALLOWED_ORIGINS =
  process.env.CORS_ALLOWED_ORIGINS || "http://localhost:3000,http://localhost:5000";
process.env.FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000";
process.env.STRIPE_WEBHOOK_SECRET =
  process.env.STRIPE_WEBHOOK_SECRET || "whsec_test_secret";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";

const app = require("../app");
const Stripe = require("stripe");
const sequelize = require("../config/db");
const User = require("../models/User");
const TradesmanDetails = require("../models/TradesmanDetails");
const TradesType = require("../models/tradesTypeModel");
const Hire = require("../models/hireModel");
const Notification = require("../models/notificationModel");
const ClientTradeAlert = require("../models/clientTradeAlertModel");
const TravelPlanAlertMatch = require("../models/travelPlanAlertMatchModel");
const StripeWebhookEvent = require("../models/StripeWebhookEvent");
const UserSubscription = require("../models/UserSubscription");
const Message = require("../models/messageModel");
const Conversation = require("../models/conversationModel");
const ConversationParticipant = require("../models/conversationParticipantModel");
const chatService = require("../services/chatService");
const {
  getCandidateLiveMatches,
} = require("../services/liveLocationService");
const {
  shouldStartBackgroundJobsInApiProcess,
} = require("../services/backgroundJobRunner");
const { resetRateLimitBuckets } = require("../middlewares/rateLimitMiddleware");
const { validateSocketLiveLocation } = require("../socket");
const emailTransporter = require("../config/email");

const DEMO_PASSWORD = "Password123!";
const uniqueSuffix = `${Date.now()}-${process.pid}`;

let server;
let baseUrl;
let initialNotificationId = 0;
const userLoginCache = new Map();
const adminLoginCache = new Map();

const request = async (method, path, { token, body, rawBody, headers = {} } = {}) => {
  const requestHeaders = {
    ...headers,
  };

  let payload = null;
  if (rawBody !== undefined) {
    payload = rawBody;
    requestHeaders["Content-Length"] = Buffer.byteLength(payload);
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    requestHeaders["Content-Type"] = "application/json";
    requestHeaders["Content-Length"] = Buffer.byteLength(payload);
  }

  if (token) {
    requestHeaders.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: requestHeaders,
    body: payload,
  });

  const text = await response.text();
  let json = null;

  try {
    json = text ? JSON.parse(text) : null;
  } catch (error) {
    json = null;
  }

  return {
    status: response.status,
    headers: response.headers,
    body: json,
    text,
  };
};

const loginUser = async (email, password = DEMO_PASSWORD) => {
  const cacheKey = `${email}:${password}`;
  if (userLoginCache.has(cacheKey)) {
    return userLoginCache.get(cacheKey);
  }

  const response = await request("POST", "/api/users/login", {
    body: { email, password },
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.success, true);
  assert.ok(response.body.data.token);

  userLoginCache.set(cacheKey, response.body.data);
  return response.body.data;
};

const loginAdmin = async (email = "admin@test.com", password = DEMO_PASSWORD) => {
  const cacheKey = `${email}:${password}`;
  if (adminLoginCache.has(cacheKey)) {
    return adminLoginCache.get(cacheKey);
  }

  const response = await request("POST", "/api/admin/login", {
    body: { email, password },
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.success, true);
  assert.ok(response.body.data.token);

  adminLoginCache.set(cacheKey, response.body.data);
  return response.body.data;
};

const createTempUnapprovedTradesman = async (options = {}) => {
  const trade = await TradesType.findOne({ where: { name: "Electrician" } });
  assert.ok(trade, "Electrician trade seed is required");

  const suffix = options.suffix || "unapproved";
  const email = `${suffix}-${uniqueSuffix}@test.com`;
  const password = await bcrypt.hash(DEMO_PASSWORD, 10);
  const user = await User.create({
    name: options.name || "Unapproved Test Tradesman",
    email,
    mobile: "0499999999",
    password,
    role: "tradesman",
    provider: "manual",
    isVerified: true,
  });

  const details = await TradesmanDetails.create({
    userId: user.id,
    tradeType: trade.name,
    tradeTypeId: trade.id,
    businessName: options.businessName || "Unapproved Test Services",
    shortBio: options.shortBio || "Temporary test user",
    licenseNumber: options.licenseNumber || "TEMP-LIC",
    licenseExpiry: options.licenseExpiry || new Date("2030-12-31"),
    licenseDocument: options.licenseDocument || null,
    portfolioPhotos: options.portfolioPhotos || [],
    isApproved: false,
  });

  return { user, details };
};

const createAcceptedHire = async (jobDescription) => {
  await Hire.update(
    { status: "cancelled", requestCompletion: false },
    {
      where: {
        jobDescription: { [Op.like]: `%${uniqueSuffix}%` },
        status: { [Op.in]: ["pending", "accepted"] },
      },
    }
  );

  const clientLogin = await loginUser("client@test.com");
  const tradesmanLogin = await loginUser("tradesman@test.com");
  const tradesman = await User.findOne({ where: { email: "tradesman@test.com" } });
  assert.ok(tradesman);

  const createResponse = await request("POST", "/api/hire/request", {
    token: clientLogin.token,
    body: {
      tradesmanId: tradesman.id,
      jobDescription,
    },
  });

  assert.equal(createResponse.status, 201);

  const acceptResponse = await request("POST", "/api/hire/respond", {
    token: tradesmanLogin.token,
    body: { hireId: createResponse.body.data.id, action: "accept" },
  });

  assert.equal(acceptResponse.status, 200);

  return {
    hireId: createResponse.body.data.id,
    clientLogin,
    tradesmanLogin,
    tradesman,
  };
};

test.before(async () => {
  await sequelize.authenticate();
  const maxNotification = await Notification.max("id");
  initialNotificationId = Number(maxNotification || 0);

  server = http.createServer(app);
  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

test.after(async () => {
  await Notification.destroy({
    where: {
      id: { [Op.gt]: initialNotificationId },
    },
  });

  await Hire.destroy({
    where: {
      jobDescription: { [Op.like]: `%${uniqueSuffix}%` },
    },
  });

  const testAlerts = await ClientTradeAlert.findAll({
    where: {
      locationName: { [Op.like]: `%${uniqueSuffix}%` },
    },
  });

  if (testAlerts.length) {
    await TravelPlanAlertMatch.destroy({
      where: { clientTradeAlertId: testAlerts.map((alert) => alert.id) },
    });
    await ClientTradeAlert.destroy({
      where: { id: testAlerts.map((alert) => alert.id) },
    });
  }

  const tempUsers = await User.findAll({
    where: {
      email: { [Op.like]: `%${uniqueSuffix}@test.com` },
    },
  });

  if (tempUsers.length) {
    await Notification.destroy({
      where: { userId: tempUsers.map((user) => user.id) },
    });
    await TradesmanDetails.destroy({
      where: { userId: tempUsers.map((user) => user.id) },
    });
    await User.destroy({
      where: { id: tempUsers.map((user) => user.id) },
    });
  }

  await StripeWebhookEvent.destroy({
    where: {
      eventId: { [Op.like]: `%${uniqueSuffix}%` },
    },
  });

  const testMessages = await Message.findAll({
    where: {
      message: { [Op.like]: `%${uniqueSuffix}%` },
    },
  });

  if (testMessages.length) {
    const conversationIds = [
      ...new Set(testMessages.map((message) => message.conversationId).filter(Boolean)),
    ];
    await Message.destroy({
      where: { id: testMessages.map((message) => message.id) },
      force: true,
    });

    if (conversationIds.length) {
      await ConversationParticipant.destroy({
        where: { conversationId: conversationIds },
      });
      await Conversation.destroy({
        where: { id: conversationIds },
      });
    }
  }

  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });

  await sequelize.close();
});

test("seeded client, tradesman, and admin can log in", async () => {
  const client = await loginUser("client@test.com");
  const tradesman = await loginUser("tradesman@test.com");
  const admin = await loginAdmin();

  assert.equal(client.user.role, "client");
  assert.equal(tradesman.user.role, "tradesman");
  assert.ok(admin.admin.email);
});

test("mobile Google login rejects fake body-provided identity", async () => {
  const response = await request("POST", "/api/auth/google/mobile", {
    body: {
      email: "attacker@example.com",
      name: "Attacker",
      token: "fake-token",
    },
  });

  assert.equal(response.status, 401);
  assert.equal(response.body.success, false);

  const user = await User.findOne({ where: { email: "attacker@example.com" } });
  assert.equal(user, null);
});

test("forgot password returns generic response without leaking reset link", async () => {
  const response = await request("POST", "/api/users/forgot-password", {
    body: { email: `missing-${uniqueSuffix}@test.com` },
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.success, true);
  assert.match(response.body.message, /If an account exists/);
  assert.match(response.body.message, /code/);
  assert.doesNotMatch(response.text, /reset-password/);
  assert.equal(response.body.data, null);
});

test("forgot password OTP can be verified before resetting password", async () => {
  resetRateLimitBuckets();

  const { user } = await createTempUnapprovedTradesman({
    suffix: "forgot-otp",
    name: "Forgot OTP Test User",
  });
  const sentMail = [];
  const originalSendMail = emailTransporter.sendMail;
  const resetHeaders = { "X-Forwarded-For": `127.0.0.${process.pid % 200}` };

  emailTransporter.sendMail = async (message) => {
    sentMail.push(message);
    return { messageId: `test-${uniqueSuffix}` };
  };

  try {
    const forgotResponse = await request("POST", "/api/users/forgot-password", {
      headers: resetHeaders,
      body: { email: user.email },
    });

    assert.equal(forgotResponse.status, 200);
    assert.equal(forgotResponse.body.success, true);
    assert.equal(sentMail.length, 1);
    assert.equal(sentMail[0].to, user.email);
    assert.match(sentMail[0].subject, /password reset code/i);
    assert.doesNotMatch(sentMail[0].text, /reset-password/);

    const otp = sentMail[0].text.match(/\b\d{6}\b/)?.[0];
    assert.ok(otp, "expected email text to include a 6 digit OTP");

    const storedOtpUser = await User.findByPk(user.id);
    assert.match(storedOtpUser.resetPasswordToken, /^otp:/);

    const invalidOtpResponse = await request("POST", "/api/users/verify-reset-otp", {
      headers: resetHeaders,
      body: { email: user.email, otp: "000000" },
    });

    assert.equal(invalidOtpResponse.status, 400);
    assert.equal(invalidOtpResponse.body.message, "Invalid or expired OTP");

    const verifyResponse = await request("POST", "/api/users/verify-reset-otp", {
      headers: resetHeaders,
      body: { email: user.email, otp },
    });

    assert.equal(verifyResponse.status, 200);
    assert.equal(verifyResponse.body.success, true);
    assert.ok(verifyResponse.body.data.resetToken);

    const storedResetUser = await User.findByPk(user.id);
    assert.match(storedResetUser.resetPasswordToken, /^reset:/);
    assert.doesNotMatch(storedResetUser.resetPasswordToken, new RegExp(otp));

    const shortPasswordResponse = await request(
      "POST",
      `/api/users/reset-password/${verifyResponse.body.data.resetToken}`,
      { headers: resetHeaders, body: { newPassword: "short" } }
    );

    assert.equal(shortPasswordResponse.status, 400);

    const newPassword = `NewPassword123!${uniqueSuffix}`;
    const resetResponse = await request(
      "POST",
      `/api/users/reset-password/${verifyResponse.body.data.resetToken}`,
      { headers: resetHeaders, body: { newPassword } }
    );

    assert.equal(resetResponse.status, 200);
    assert.equal(resetResponse.body.message, "Password reset successful");

    const loginResponse = await request("POST", "/api/users/login", {
      body: { email: user.email, password: newPassword },
    });

    assert.equal(loginResponse.status, 200);
    assert.equal(loginResponse.body.success, true);
  } finally {
    emailTransporter.sendMail = originalSendMail;
  }
});

test("admin registration requires admin token after bootstrap admin exists", async () => {
  const response = await request("POST", "/api/admin/register", {
    body: {
      name: "Blocked Admin",
      email: `blocked-admin-${uniqueSuffix}@test.com`,
      password: DEMO_PASSWORD,
    },
  });

  assert.equal(response.status, 401);
});

const FORBIDDEN_PUBLIC_USER_KEYS = [
  "password",
  "resetPasswordToken",
  "resetPasswordExpires",
  "email",
  "mobile",
  "googleId",
  "provider",
  "licenseNumber",
  "licenseDocument",
  "approvedBy",
  "rejectionReason",
];

const assertNoForbiddenKeys = (value) => {
  const serialized = JSON.stringify(value);

  for (const key of FORBIDDEN_PUBLIC_USER_KEYS) {
    assert.equal(
      serialized.includes(`"${key}":`),
      false,
      `public user data must not contain "${key}"`
    );
  }
};

test("user directory endpoints require a login", async () => {
  const list = await request("GET", "/api/users");
  const clients = await request("GET", "/api/users/clients");

  assert.equal(list.status, 401);
  assert.equal(list.body.code, "TOKEN_MISSING");
  assert.equal(clients.status, 401);
});

test("user list responses return only the public profile shape", async () => {
  const clientLogin = await loginUser("client@test.com");
  const response = await request("GET", "/api/users", { token: clientLogin.token });

  assert.equal(response.status, 200);
  const users = response.body.data.data;
  assert.ok(Array.isArray(users));
  assert.ok(users.length >= 2);

  for (const user of users) {
    assert.ok(Object.hasOwn(user, "id"));
    assert.ok(Object.hasOwn(user, "name"));
  }

  assertNoForbiddenKeys(response.body);
});

test("client list and public profile endpoints do not expose contact or licence details", async () => {
  const clientLogin = await loginUser("client@test.com");
  const tradesman = await User.findOne({ where: { email: "tradesman@test.com" } });
  assert.ok(tradesman);

  const clients = await request("GET", "/api/users/clients", { token: clientLogin.token });
  assert.equal(clients.status, 200);
  assertNoForbiddenKeys(clients.body);

  const profile = await request("GET", `/api/users/${tradesman.id}`);
  assert.equal(profile.status, 200);
  assertNoForbiddenKeys(profile.body);

  const tradesmen = await request("GET", "/api/users/tradesmen");
  assert.ok([200, 404].includes(tradesmen.status));
  assertNoForbiddenKeys(tradesmen.body);

  // The filter response includes where tradesmen are, so it needs a login.
  const anonymousFilter = await request("GET", "/api/users/tradesmen/filter");
  assert.equal(anonymousFilter.status, 401);
  assert.equal(anonymousFilter.body.code, "TOKEN_MISSING");

  const filter = await request("GET", "/api/users/tradesmen/filter", {
    token: clientLogin.token,
  });
  assert.equal(filter.status, 200);
  assertNoForbiddenKeys(filter.body);
});

test("authenticated users cannot delete other user accounts", async () => {
  const clientLogin = await loginUser("client@test.com");
  const tradesman = await User.findOne({ where: { email: "tradesman@test.com" } });
  assert.ok(tradesman);

  const response = await request("DELETE", `/api/users/${tradesman.id}`, {
    token: clientLogin.token,
  });

  assert.equal(response.status, 403);
  assert.equal(response.body.success, false);
});

test("profile update cannot self-approve an unapproved tradesman", async () => {
  const { user } = await createTempUnapprovedTradesman();
  const login = await loginUser(user.email);

  const response = await request("PUT", "/api/users/profile", {
    token: login.token,
    body: {
      businessName: "Still Unapproved Test Services",
      isApproved: true,
    },
  });

  assert.equal(response.status, 200);

  const details = await TradesmanDetails.findOne({ where: { userId: user.id } });
  assert.equal(Boolean(details.isApproved), false);
});

test("admin pending tradesman search works with MySQL-compatible operators", async () => {
  const { user } = await createTempUnapprovedTradesman({
    suffix: "approval-search",
    name: "Approval Search Candidate",
  });
  const adminLogin = await loginAdmin();

  const response = await request(
    "GET",
    `/api/admin/tradesmen/pending?search=${encodeURIComponent("Approval Search")}`,
    { token: adminLogin.token }
  );

  assert.equal(response.status, 200);
  assert.equal(response.body.success, true);
  assert.ok(
    response.body.data.data.some((row) => row.user?.id === user.id),
    "expected pending search to include the temporary tradesman"
  );
});

test("admin approval rejects incomplete tradesman profiles", async () => {
  const { user } = await createTempUnapprovedTradesman({
    suffix: "approval-incomplete",
    licenseDocument: null,
    portfolioPhotos: [],
  });
  const adminLogin = await loginAdmin();

  const response = await request(
    "POST",
    `/api/admin/tradesmen/${user.id}/approve`,
    { token: adminLogin.token }
  );

  assert.equal(response.status, 400);
  assert.equal(response.body.message, "Tradesman profile is incomplete");
  assert.ok(response.body.data.missingFields.includes("licenseDocument"));
  assert.ok(response.body.data.missingFields.includes("portfolioPhotos"));
});

test("admin rejection requires a reason", async () => {
  const { user } = await createTempUnapprovedTradesman({
    suffix: "approval-reject",
  });
  const adminLogin = await loginAdmin();

  const response = await request(
    "POST",
    `/api/admin/tradesmen/${user.id}/reject`,
    { token: adminLogin.token, body: {} }
  );

  assert.equal(response.status, 400);
  assert.equal(response.body.message, "Rejection reason is required");
});

test("admin tradesman detail response does not expose password fields", async () => {
  const { user } = await createTempUnapprovedTradesman({
    suffix: "approval-detail",
  });
  const adminLogin = await loginAdmin();

  const response = await request(
    "GET",
    `/api/admin/tradesmen/${user.id}`,
    { token: adminLogin.token }
  );

  assert.equal(response.status, 200);
  assert.equal(response.body.success, true);
  assert.equal(Object.hasOwn(response.body.data.user, "password"), false);
  assert.equal(Object.hasOwn(response.body.data.user, "resetPasswordToken"), false);
  assert.equal(Object.hasOwn(response.body.data.user, "resetPasswordExpires"), false);
});

test("hire request endpoint rejects tradesman callers", async () => {
  const tradesmanLogin = await loginUser("tradesman@test.com");

  const response = await request("POST", "/api/hire/request", {
    token: tradesmanLogin.token,
    body: {
      tradesmanId: 2,
      jobDescription: `security-test-hire-${uniqueSuffix}`,
    },
  });

  assert.equal(response.status, 403);
  assert.equal(response.body.message, "Only clients can send hire requests");
});

test("hire request endpoint requires target to be an approved tradesman", async () => {
  const clientLogin = await loginUser("client@test.com");

  const response = await request("POST", "/api/hire/request", {
    token: clientLogin.token,
    body: {
      tradesmanId: 999999,
      jobDescription: `security-test-hire-${uniqueSuffix}`,
    },
  });

  assert.equal(response.status, 400);
  assert.equal(response.body.message, "Target must be an approved tradesman");
});

test("hire request endpoint validates required body fields", async () => {
  const clientLogin = await loginUser("client@test.com");

  const response = await request("POST", "/api/hire/request", {
    token: clientLogin.token,
    body: {
      tradesmanId: "not-a-number",
      jobDescription: "",
    },
  });

  assert.equal(response.status, 400);
  assert.equal(response.body.message, "tradesmanId must be a positive integer");
});

test("hire status transitions only allow pending hire responses once", async () => {
  const clientLogin = await loginUser("client@test.com");
  const tradesmanLogin = await loginUser("tradesman@test.com");
  const tradesman = await User.findOne({ where: { email: "tradesman@test.com" } });

  const createResponse = await request("POST", "/api/hire/request", {
    token: clientLogin.token,
    body: {
      tradesmanId: tradesman.id,
      jobDescription: `security-test-hire-${uniqueSuffix}`,
    },
  });

  assert.equal(createResponse.status, 201);
  const hireId = createResponse.body.data.id;

  const acceptResponse = await request("POST", "/api/hire/respond", {
    token: tradesmanLogin.token,
    body: { hireId, action: "accept" },
  });

  assert.equal(acceptResponse.status, 200);
  assert.equal(acceptResponse.body.data.status, "accepted");

  const secondAcceptResponse = await request("POST", "/api/hire/respond", {
    token: tradesmanLogin.token,
    body: { hireId, action: "accept" },
  });

  assert.equal(secondAcceptResponse.status, 404);

  await Hire.update(
    { status: "cancelled", requestCompletion: false },
    { where: { id: hireId } }
  );
});

test("hire cancel endpoint cancels an accepted hire and exposes cancelled filter", async () => {
  const { hireId, clientLogin } = await createAcceptedHire(
    `security-test-cancel-${uniqueSuffix}`
  );

  const cancelResponse = await request("POST", "/api/hire/cancel", {
    token: clientLogin.token,
    body: { hireId, reason: "No longer needed" },
  });

  assert.equal(cancelResponse.status, 200);
  assert.equal(cancelResponse.body.success, true);
  assert.equal(cancelResponse.body.data.status, "cancelled");

  const jobsResponse = await request("GET", "/api/hire/my?filter=cancelled", {
    token: clientLogin.token,
  });

  assert.equal(jobsResponse.status, 200);
  assert.ok(jobsResponse.body.data.some((job) => job.id === hireId));
});

test("hire cancel endpoint refuses completed hires", async () => {
  const { hireId, clientLogin, tradesmanLogin } = await createAcceptedHire(
    `security-test-completed-${uniqueSuffix}`
  );

  const requestCompleteResponse = await request("POST", "/api/hire/request-complete", {
    token: tradesmanLogin.token,
    body: { hireId },
  });

  assert.equal(requestCompleteResponse.status, 200);

  const confirmResponse = await request("POST", "/api/hire/confirm-complete", {
    token: clientLogin.token,
    body: { hireId, confirm: true },
  });

  assert.equal(confirmResponse.status, 200);
  assert.equal(confirmResponse.body.data.status, "completed");

  const cancelResponse = await request("POST", "/api/hire/cancel", {
    token: clientLogin.token,
    body: { hireId, reason: "Too late" },
  });

  assert.equal(cancelResponse.status, 400);
  assert.equal(cancelResponse.body.message, "Cannot cancel a completed hire");
});

test("my jobs endpoint validates filter values", async () => {
  const clientLogin = await loginUser("client@test.com");

  const response = await request("GET", "/api/hire/my?filter=unknown", {
    token: clientLogin.token,
  });

  assert.equal(response.status, 400);
  assert.match(response.body.message, /filter must be one of/);
});

test("background jobs are gated off by default in production API process", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalFlag = process.env.ENABLE_API_BACKGROUND_JOBS;

  process.env.NODE_ENV = "production";
  delete process.env.ENABLE_API_BACKGROUND_JOBS;
  assert.equal(shouldStartBackgroundJobsInApiProcess(), false);

  process.env.ENABLE_API_BACKGROUND_JOBS = "true";
  assert.equal(shouldStartBackgroundJobsInApiProcess(), true);

  process.env.ENABLE_API_BACKGROUND_JOBS = "false";
  assert.equal(shouldStartBackgroundJobsInApiProcess(), false);

  if (originalNodeEnv === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = originalNodeEnv;
  }

  if (originalFlag === undefined) {
    delete process.env.ENABLE_API_BACKGROUND_JOBS;
  } else {
    process.env.ENABLE_API_BACKGROUND_JOBS = originalFlag;
  }
});

test("proxy trust is disabled unless explicitly configured", () => {
  assert.equal(app.get("trust proxy"), false);
});

test("live location endpoint rejects clients and invalid coordinates", async () => {
  const clientLogin = await loginUser("client@test.com");
  const tradesmanLogin = await loginUser("tradesman@test.com");

  const clientResponse = await request("POST", "/api/location/live-update", {
    token: clientLogin.token,
    body: { latitude: -33.86, longitude: 151.2 },
  });

  assert.equal(clientResponse.status, 403);
  assert.equal(clientResponse.body.message, "Only tradesmen can update live location");

  const invalidCoordinateResponse = await request("POST", "/api/location/live-update", {
    token: tradesmanLogin.token,
    body: { latitude: -100, longitude: 151.2 },
  });

  assert.equal(invalidCoordinateResponse.status, 400);
  assert.equal(
    invalidCoordinateResponse.body.message,
    "latitude or longitude is outside the valid range"
  );
});

test("live location candidate query starts from existing active matches", async () => {
  const client = await User.findOne({ where: { email: "client@test.com" } });
  const tradesman = await User.findOne({ where: { email: "tradesman@test.com" } });
  const tradesmanDetails = await TradesmanDetails.findOne({
    where: { userId: tradesman.id },
  });

  const activeAlert = await ClientTradeAlert.create({
    clientId: client.id,
    tradeType: tradesmanDetails.tradeType,
    tradeTypeId: tradesmanDetails.tradeTypeId,
    locationName: `candidate-active-${uniqueSuffix}`,
    latitude: -33.86,
    longitude: 151.2,
    radiusKm: 15,
    isActive: true,
  });

  const unmatchedAlert = await ClientTradeAlert.create({
    clientId: client.id,
    tradeType: tradesmanDetails.tradeType,
    tradeTypeId: tradesmanDetails.tradeTypeId,
    locationName: `candidate-unmatched-${uniqueSuffix}`,
    latitude: -33.86,
    longitude: 151.2,
    radiusKm: 15,
    isActive: true,
  });

  const expiredAlert = await ClientTradeAlert.create({
    clientId: client.id,
    tradeType: tradesmanDetails.tradeType,
    tradeTypeId: tradesmanDetails.tradeTypeId,
    locationName: `candidate-expired-${uniqueSuffix}`,
    latitude: -33.86,
    longitude: 151.2,
    radiusKm: 15,
    isActive: true,
    endDate: new Date("2020-01-01"),
  });

  await TravelPlanAlertMatch.bulkCreate([
    {
      travelPlanId: 123456,
      tradesmanId: tradesman.id,
      clientId: client.id,
      clientTradeAlertId: activeAlert.id,
      status: "pending",
    },
    {
      travelPlanId: 123456,
      tradesmanId: tradesman.id,
      clientId: client.id,
      clientTradeAlertId: expiredAlert.id,
      status: "pending",
    },
  ]);

  const candidates = await getCandidateLiveMatches({
    travelPlanId: 123456,
    tradesmanId: tradesman.id,
    tradeTypeId: tradesmanDetails.tradeTypeId,
    now: new Date(),
  });

  assert.deepEqual(
    candidates.map((item) => Number(item.alert.id)).sort((a, b) => a - b),
    [Number(activeAlert.id)]
  );
  assert.equal(
    candidates.some((item) => Number(item.alert.id) === Number(unmatchedAlert.id)),
    false
  );
});

test("stripe webhook records processed events and ignores duplicates", async () => {
  const stripe = new Stripe("sk_test_placeholder");
  const payload = JSON.stringify({
    id: `evt_${uniqueSuffix}`,
    object: "event",
    type: "invoice.paid",
    data: {
      object: {
        id: `in_${uniqueSuffix}`,
        object: "invoice",
        subscription: `sub_${uniqueSuffix}`,
      },
    },
  });
  const signature = stripe.webhooks.generateTestHeaderString({
    payload,
    secret: process.env.STRIPE_WEBHOOK_SECRET,
  });

  const firstResponse = await request("POST", "/api/subscriptions/webhook", {
    rawBody: payload,
    headers: {
      "Content-Type": "application/json",
      "Stripe-Signature": signature,
    },
  });

  assert.equal(firstResponse.status, 200);
  assert.equal(firstResponse.body.received, true);

  const secondResponse = await request("POST", "/api/subscriptions/webhook", {
    rawBody: payload,
    headers: {
      "Content-Type": "application/json",
      "Stripe-Signature": signature,
    },
  });

  assert.equal(secondResponse.status, 200);
  assert.equal(secondResponse.body.received, true);
  assert.equal(secondResponse.body.duplicate, true);

  const storedEvent = await StripeWebhookEvent.findByPk(`evt_${uniqueSuffix}`);
  assert.ok(storedEvent.processedAt);
  assert.equal(storedEvent.status, "processed");
});

test("stripe webhook retries failed events instead of treating them as duplicates", async () => {
  const stripe = new Stripe("sk_test_placeholder");
  const eventId = `evt_retry_${uniqueSuffix}`;
  const payload = JSON.stringify({
    id: eventId,
    object: "event",
    type: "invoice.paid",
    data: {
      object: {
        id: `in_retry_${uniqueSuffix}`,
        object: "invoice",
        subscription: `sub_retry_${uniqueSuffix}`,
      },
    },
  });
  const signature = stripe.webhooks.generateTestHeaderString({
    payload,
    secret: process.env.STRIPE_WEBHOOK_SECRET,
  });
  const headers = {
    "Content-Type": "application/json",
    "Stripe-Signature": signature,
  };
  const originalUpdate = UserSubscription.update;

  UserSubscription.update = async () => {
    throw new Error("forced webhook update failure");
  };

  try {
    const failedResponse = await request("POST", "/api/subscriptions/webhook", {
      rawBody: payload,
      headers,
    });

    assert.equal(failedResponse.status, 500);

    const failedEvent = await StripeWebhookEvent.findByPk(eventId);
    assert.ok(failedEvent);
    assert.equal(failedEvent.status, "failed");
    assert.equal(failedEvent.processedAt, null);
  } finally {
    UserSubscription.update = originalUpdate;
  }

  const retryResponse = await request("POST", "/api/subscriptions/webhook", {
    rawBody: payload,
    headers,
  });

  assert.equal(retryResponse.status, 200);
  assert.equal(retryResponse.body.received, true);
  assert.equal(retryResponse.body.duplicate, undefined);

  const processedEvent = await StripeWebhookEvent.findByPk(eventId);
  assert.equal(processedEvent.status, "processed");
  assert.ok(processedEvent.processedAt);
});

test("socket live-location validation matches REST rules", () => {
  const clientValidation = validateSocketLiveLocation(
    { id: 1, role: "client" },
    { latitude: -33.86, longitude: 151.2 }
  );

  assert.equal(clientValidation.success, false);
  assert.equal(clientValidation.message, "Only tradesmen can update live location");

  const rangeValidation = validateSocketLiveLocation(
    { id: 2, role: "tradesman" },
    { latitude: 91, longitude: 151.2 }
  );

  assert.equal(rangeValidation.success, false);
  assert.equal(rangeValidation.message, "latitude or longitude is outside the valid range");

  const valid = validateSocketLiveLocation(
    { id: 2, role: "tradesman" },
    { latitude: "-33.86", longitude: "151.2" }
  );

  assert.equal(valid.success, true);
  assert.equal(valid.latitude, -33.86);
  assert.equal(valid.longitude, 151.2);
});

test("chat shared send path rejects overlong messages", async () => {
  const client = await User.findOne({ where: { email: "client@test.com" } });
  const tradesman = await User.findOne({ where: { email: "tradesman@test.com" } });

  await assert.rejects(
    () =>
      chatService.sendDirectMessage({
        senderId: client.id,
        receiverId: tradesman.id,
        message: "x".repeat(chatService.MAX_MESSAGE_LENGTH + 1),
      }),
    /message must be/
  );
});

test("chat REST send path uses shared service and keeps push-only chat out of inbox", async () => {
  const clientLogin = await loginUser("client@test.com");
  const tradesman = await User.findOne({ where: { email: "tradesman@test.com" } });
  const beforeNotificationCount = await Notification.count();
  const message = `security-chat-${uniqueSuffix}`;

  const response = await request("POST", "/api/chat/send", {
    token: clientLogin.token,
    body: {
      receiverId: tradesman.id,
      message,
    },
  });

  assert.equal(response.status, 201);
  assert.equal(response.body.success, true);
  assert.equal(response.body.data.message, message);

  const afterNotificationCount = await Notification.count();
  assert.equal(afterNotificationCount, beforeNotificationCount);
});
