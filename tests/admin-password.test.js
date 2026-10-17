const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const test = require("node:test");
const bcrypt = require("bcryptjs");

process.env.CORS_ALLOWED_ORIGINS =
  process.env.CORS_ALLOWED_ORIGINS || "http://localhost:3000,http://localhost:5000";
process.env.FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000";
process.env.STRIPE_WEBHOOK_SECRET =
  process.env.STRIPE_WEBHOOK_SECRET || "whsec_test_secret";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";

const app = require("../app");
const sequelize = require("../config/db");
const Admin = require("../models/AdminModel/adminModel");
const { resetRateLimitBuckets } = require("../middlewares/rateLimitMiddleware");

const OLD_PASSWORD = "OldPassword123!";
const uniqueSuffix = `${Date.now()}-${process.pid}`;
const adminEmail = `admin-pw-${uniqueSuffix}@test.com`;

let server;
let baseUrl;
let admin;

const hash = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");

const post = async (path, { token, body } = {}) => {
  // Rate limiting is not under test here; keep multi-step flows under the cap.
  resetRateLimitBuckets();
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body || {}),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
};

const login = (password) =>
  post("/api/admin/login", { body: { email: adminEmail, password } });

// Plants a known OTP, standing in for the one that is emailed.
const plantOtp = (otp, expires = new Date(Date.now() + 5 * 60 * 1000)) =>
  admin.update({
    resetPasswordToken: `otp:${hash(otp)}`,
    resetPasswordExpires: expires,
    resetPasswordAttempts: 0,
  });

test.before(async () => {
  await sequelize.authenticate();
  admin = await Admin.create({
    name: "Password Test Admin",
    email: adminEmail,
    password: await bcrypt.hash(OLD_PASSWORD, 10),
  });

  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.beforeEach(() => {
  resetRateLimitBuckets();
});

test.after(async () => {
  await Admin.destroy({ where: { id: admin.id } });
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await sequelize.close();
});

test("admin can change password while logged in", async () => {
  const { body } = await login(OLD_PASSWORD);
  const token = body.data.token;
  const newPassword = "ChangedPassword123!";

  const wrongOld = await post("/api/admin/change-password", {
    token,
    body: { oldPassword: "nope", newPassword, confirmNewPassword: newPassword },
  });
  assert.equal(wrongOld.status, 400);

  const mismatch = await post("/api/admin/change-password", {
    token,
    body: { oldPassword: OLD_PASSWORD, newPassword, confirmNewPassword: "different" },
  });
  assert.equal(mismatch.status, 400);

  const tooShort = await post("/api/admin/change-password", {
    token,
    body: { oldPassword: OLD_PASSWORD, newPassword: "short", confirmNewPassword: "short" },
  });
  assert.equal(tooShort.status, 400);

  const same = await post("/api/admin/change-password", {
    token,
    body: {
      oldPassword: OLD_PASSWORD,
      newPassword: OLD_PASSWORD,
      confirmNewPassword: OLD_PASSWORD,
    },
  });
  assert.equal(same.status, 400);

  const unauthenticated = await post("/api/admin/change-password", {
    body: { oldPassword: OLD_PASSWORD, newPassword, confirmNewPassword: newPassword },
  });
  assert.equal(unauthenticated.status, 401);

  const ok = await post("/api/admin/change-password", {
    token,
    body: { oldPassword: OLD_PASSWORD, newPassword, confirmNewPassword: newPassword },
  });
  assert.equal(ok.status, 200);

  assert.equal((await login(OLD_PASSWORD)).status, 400);
  assert.equal((await login(newPassword)).status, 200);

  // Restore for the following tests.
  await admin.update({ password: await bcrypt.hash(OLD_PASSWORD, 10) });
});

test("forgot password does not reveal whether an admin exists", async () => {
  const unknown = await post("/api/admin/forgot-password", {
    body: { email: `nobody-${uniqueSuffix}@test.com` },
  });
  assert.equal(unknown.status, 200);

  const missing = await post("/api/admin/forgot-password", { body: {} });
  assert.equal(missing.status, 400);

  const known = await post("/api/admin/forgot-password", { body: { email: adminEmail } });
  assert.equal(known.status, 200);
  assert.equal(known.body.message, unknown.body.message);

  await admin.reload();
  assert.match(admin.resetPasswordToken, /^otp:[0-9a-f]{64}$/);
  assert.ok(admin.resetPasswordExpires > new Date());
});

test("OTP flow resets the password and tokens are single use", async () => {
  await plantOtp("482913");

  const wrong = await post("/api/admin/verify-otp", {
    body: { email: adminEmail, otp: "000000" },
  });
  assert.equal(wrong.status, 400);

  const verified = await post("/api/admin/verify-otp", {
    body: { email: adminEmail, otp: "482913" },
  });
  assert.equal(verified.status, 200);
  const { resetToken } = verified.body.data;
  assert.ok(resetToken);

  const reusedOtp = await post("/api/admin/verify-otp", {
    body: { email: adminEmail, otp: "482913" },
  });
  assert.equal(reusedOtp.status, 400);

  const short = await post(`/api/admin/reset-password/${resetToken}`, {
    body: { newPassword: "short" },
  });
  assert.equal(short.status, 400);

  const newPassword = "ResetPassword123!";
  const reset = await post(`/api/admin/reset-password/${resetToken}`, {
    body: { newPassword },
  });
  assert.equal(reset.status, 200);

  const reusedToken = await post(`/api/admin/reset-password/${resetToken}`, {
    body: { newPassword: "AnotherPassword123!" },
  });
  assert.equal(reusedToken.status, 400);

  assert.equal((await login(OLD_PASSWORD)).status, 400);
  assert.equal((await login(newPassword)).status, 200);

  await admin.update({ password: await bcrypt.hash(OLD_PASSWORD, 10) });
});

test("expired OTP is rejected", async () => {
  await plantOtp("111222", new Date(Date.now() - 1000));

  const response = await post("/api/admin/verify-otp", {
    body: { email: adminEmail, otp: "111222" },
  });
  assert.equal(response.status, 400);
});

test("OTP is invalidated after too many wrong attempts", async () => {
  await plantOtp("333444");

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await post("/api/admin/verify-otp", {
      body: { email: adminEmail, otp: "999999" },
    });
    assert.equal(response.status, 400);
  }

  const correctButLocked = await post("/api/admin/verify-otp", {
    body: { email: adminEmail, otp: "333444" },
  });
  assert.equal(correctButLocked.status, 400);
});
