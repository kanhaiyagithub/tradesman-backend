const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");

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

const PASSWORD = "FirstAdmin123!";
const uniqueSuffix = `${Date.now()}-${process.pid}`;
const firstEmail = `first-admin-${uniqueSuffix}@test.com`;

let server;
let baseUrl;
let tableWasEmpty = false;

const login = async (body) => {
  resetRateLimitBuckets();
  const response = await fetch(`${baseUrl}/api/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
};

test.before(async () => {
  await sequelize.authenticate();
  tableWasEmpty = (await Admin.count()) === 0;

  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (tableWasEmpty) {
    await Admin.destroy({ where: { email: firstEmail } });
  }
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await sequelize.close();
});

test("first login on an empty admin table registers the first admin", async (t) => {
  if (!tableWasEmpty) {
    t.skip("admins already exist in this database");
    return;
  }

  const invalid = await login({ email: firstEmail, password: "short" });
  assert.equal(invalid.status, 400);
  assert.equal(await Admin.count(), 0);

  const first = await login({ email: firstEmail, password: PASSWORD });
  assert.equal(first.status, 201);
  assert.equal(first.body.data.registered, true);
  assert.ok(first.body.data.token);
  assert.equal(await Admin.count(), 1);

  // An admin now exists, so later logins behave as normal logins.
  const wrongPassword = await login({ email: firstEmail, password: "WrongPassword1!" });
  assert.equal(wrongPassword.status, 400);

  const second = await login({ email: firstEmail, password: PASSWORD });
  assert.equal(second.status, 200);
  assert.equal(second.body.data.registered, undefined);

  const stranger = await login({ email: `other-${uniqueSuffix}@test.com`, password: PASSWORD });
  assert.equal(stranger.status, 400);
  assert.equal(await Admin.count(), 1);
});
