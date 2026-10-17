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
const socketModule = require("../socket");
const { emitToAdmins, APPROVALS_EVENT } = require("../services/adminEventService");

const uniqueSuffix = `${Date.now()}-${process.pid}`;

let server;
let baseUrl;
let admin;
let token;

test.before(async () => {
  await sequelize.authenticate();
  admin = await Admin.create({
    name: "Live Admin",
    email: `live-admin-${uniqueSuffix}@test.com`,
    password: await bcrypt.hash("Password123!", 10),
  });
  token = jwt.sign({ id: admin.id, role: "admin" }, process.env.JWT_SECRET, { expiresIn: "1h" });

  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await Admin.destroy({ where: { id: admin.id } });
  await sequelize.close();
});

test("pending-count needs an admin token", async () => {
  const response = await fetch(`${baseUrl}/api/admin/tradesmen/pending-count`);
  assert.equal(response.status, 401);
});

test("pending-count returns the queue size (and is not captured by /tradesmen/:userId)", async () => {
  const response = await fetch(`${baseUrl}/api/admin/tradesmen/pending-count`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.success, true);
  assert.equal(typeof body.data.count, "number");
  assert.equal(body.data.count, body.data.pending + body.data.resubmitted);
});

test("emitToAdmins sends only to the admins room", () => {
  const original = socketModule.getIO;
  const sent = [];
  socketModule.getIO = () => ({
    to: (room) => ({ emit: (event, payload) => sent.push({ room, event, payload }) }),
  });

  try {
    assert.equal(emitToAdmins(APPROVALS_EVENT, { count: 3 }), true);
  } finally {
    socketModule.getIO = original;
  }

  assert.deepEqual(sent, [{ room: "admins", event: APPROVALS_EVENT, payload: { count: 3 } }]);
});

test("emitToAdmins is a quiet no-op when sockets are not running", () => {
  const original = socketModule.getIO;
  socketModule.getIO = () => {
    throw new Error("Socket.io not initialized");
  };

  try {
    assert.equal(emitToAdmins(APPROVALS_EVENT, {}), false);
  } finally {
    socketModule.getIO = original;
  }
});
