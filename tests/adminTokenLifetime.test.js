const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";

const app = require("../app");
const sequelize = require("../config/db");
const Admin = require("../models/AdminModel/adminModel");
const { resetRateLimitBuckets } = require("../middlewares/rateLimitMiddleware");

const PASSWORD = "Password123!";
const email = `token-life-${Date.now()}-${process.pid}@test.com`;

let server;
let baseUrl;
let admin;

test.before(async () => {
  await sequelize.authenticate();
  admin = await Admin.create({
    name: "Token Life",
    email,
    password: await bcrypt.hash(PASSWORD, 10),
  });
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await Admin.destroy({ where: { id: admin.id } });
  await sequelize.close();
});

test("an admin login token lasts one day", async () => {
  resetRateLimitBuckets();
  const response = await fetch(`${baseUrl}/api/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  assert.equal(response.status, 200);

  const { token } = (await response.json()).data;
  const claims = jwt.verify(token, process.env.JWT_SECRET);
  assert.equal(claims.role, "admin");
  assert.equal(claims.exp - claims.iat, 24 * 60 * 60);
});

test("an expired admin token is rejected with 401", async () => {
  const expired = jwt.sign({ id: admin.id, role: "admin" }, process.env.JWT_SECRET, { expiresIn: -10 });
  const response = await fetch(`${baseUrl}/api/admin/admins`, {
    headers: { Authorization: `Bearer ${expired}` },
  });
  assert.equal(response.status, 401);

  const fresh = jwt.sign({ id: admin.id, role: "admin" }, process.env.JWT_SECRET, { expiresIn: "1d" });
  const ok = await fetch(`${baseUrl}/api/admin/admins`, { headers: { Authorization: `Bearer ${fresh}` } });
  assert.equal(ok.status, 200);
});
