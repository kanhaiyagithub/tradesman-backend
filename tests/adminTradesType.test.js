const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret";

const app = require("../app");
const sequelize = require("../config/db");
const Admin = require("../models/AdminModel/adminModel");
const User = require("../models/User");
const TradesType = require("../models/tradesTypeModel");
const TradesmanDetails = require("../models/TradesmanDetails");

const uniqueSuffix = `${Date.now()}-${process.pid}`;
const createdTradeIds = [];

let server;
let baseUrl;
let admin;
let token;
let user;

const call = async (method, path, { auth = true, body } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(auth ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
};

test.before(async () => {
  await sequelize.authenticate();
  admin = await Admin.create({
    name: "Trades Admin",
    email: `trades-admin-${uniqueSuffix}@test.com`,
    password: await bcrypt.hash("Password123!", 10),
  });
  token = jwt.sign({ id: admin.id, role: "admin" }, process.env.JWT_SECRET);

  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (user) {
    await TradesmanDetails.destroy({ where: { userId: user.id } });
    await User.destroy({ where: { id: user.id } });
  }
  await TradesType.destroy({ where: { id: createdTradeIds } });
  await Admin.destroy({ where: { id: admin.id } });
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await sequelize.close();
});

test("trade type endpoints require an admin token", async () => {
  assert.equal((await call("GET", "/api/admin/trades", { auth: false })).status, 401);
  assert.equal(
    (await call("POST", "/api/admin/trades", { auth: false, body: { name: "x", category: "y" } })).status,
    401
  );
  assert.equal((await call("DELETE", "/api/admin/trades/1", { auth: false })).status, 401);
});

test("admin can add a trade type with validation and duplicate protection", async () => {
  const name = `Test Welder ${uniqueSuffix}`;
  const category = "Test Construction";

  assert.equal((await call("POST", "/api/admin/trades", { body: { category } })).status, 400);
  assert.equal((await call("POST", "/api/admin/trades", { body: { name } })).status, 400);
  assert.equal((await call("POST", "/api/admin/trades", { body: { name: "  ", category } })).status, 400);
  assert.equal(
    (await call("POST", "/api/admin/trades", { body: { name: "x".repeat(256), category } })).status,
    400
  );

  const created = await call("POST", "/api/admin/trades", { body: { name: `  ${name}  `, category } });
  assert.equal(created.status, 201);
  assert.equal(created.body.data.name, name);
  assert.equal(created.body.data.isActive, true);
  createdTradeIds.push(created.body.data.id);

  const duplicate = await call("POST", "/api/admin/trades", { body: { name, category } });
  assert.equal(duplicate.status, 409);

  // The public list now includes it.
  const publicList = await fetch(`${baseUrl}/api/trades`).then((r) => r.json());
  assert.ok(publicList.data.some((trade) => trade.id === created.body.data.id));
});

test("an unused trade type is deleted", async () => {
  const trade = await TradesType.create({
    name: `Test Unused ${uniqueSuffix}`,
    category: "Test",
    isActive: true,
  });
  createdTradeIds.push(trade.id);

  assert.equal((await call("DELETE", "/api/admin/trades/abc")).status, 400);
  assert.equal((await call("DELETE", "/api/admin/trades/999999999")).status, 404);

  const deleted = await call("DELETE", `/api/admin/trades/${trade.id}`);
  assert.equal(deleted.status, 200);
  assert.equal(await TradesType.findByPk(trade.id), null);
});

test("a trade type in use is protected, and can be deactivated and re-added", async () => {
  const trade = await TradesType.create({
    name: `Test In Use ${uniqueSuffix}`,
    category: "Test",
    isActive: true,
  });
  createdTradeIds.push(trade.id);

  user = await User.create({
    name: "Trade In Use",
    email: `trade-in-use-${uniqueSuffix}@test.com`,
    password: await bcrypt.hash("Password123!", 10),
    role: "tradesman",
    provider: "manual",
  });
  await TradesmanDetails.create({
    userId: user.id,
    tradeType: trade.name,
    tradeTypeId: trade.id,
    isApproved: false,
  });

  const blocked = await call("DELETE", `/api/admin/trades/${trade.id}`);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.data.inUse.tradesmen, 1);
  assert.ok(await TradesType.findByPk(trade.id));

  const deactivated = await call("DELETE", `/api/admin/trades/${trade.id}?deactivate=true`);
  assert.equal(deactivated.status, 200);
  await trade.reload();
  assert.equal(trade.isActive, false);

  const publicList = await fetch(`${baseUrl}/api/trades`).then((r) => r.json());
  assert.ok(!publicList.data.some((t) => t.id === trade.id));

  const adminList = await call("GET", "/api/admin/trades");
  assert.ok(adminList.body.data.some((t) => t.id === trade.id));

  const readded = await call("POST", "/api/admin/trades", {
    body: { name: trade.name, category: trade.category },
  });
  assert.equal(readded.status, 200);
  await trade.reload();
  assert.equal(trade.isActive, true);
});
