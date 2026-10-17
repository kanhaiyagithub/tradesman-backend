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
const { transferSuperAdmin } = require("../services/superAdminService");

const uniqueSuffix = `${Date.now()}-${process.pid}`;
const PASSWORD = "Password123!";
const createdIds = [];

let server;
let baseUrl;
let originalSuperId = null; // restored in test.after so real data is left as found
let superAdmin;
let tokens = {};

const tokenFor = (admin) =>
  jwt.sign({ id: admin.id, role: "admin" }, process.env.JWT_SECRET, { expiresIn: "1h" });

const makeAdmin = async (label) => {
  const admin = await Admin.create({
    name: `Test ${label}`,
    email: `mgmt-${label}-${uniqueSuffix}@test.com`,
    password: await bcrypt.hash(PASSWORD, 10),
  });
  createdIds.push(admin.id);
  tokens[admin.id] = tokenFor(admin);
  return admin;
};

const call = async (method, path, { as, body } = {}) => {
  resetRateLimitBuckets();
  const token = as === null ? null : tokens[as.id];
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
};

const roles = async () => {
  const rows = await Admin.findAll({ attributes: ["id", "role"] });
  return Object.fromEntries(rows.map((row) => [row.id, row.role]));
};

const superCount = async () => (await Admin.count({ where: { role: "super_admin" } }));

test.before(async () => {
  await sequelize.authenticate();

  const existing = await Admin.findOne({ where: { role: "super_admin" } });
  originalSuperId = existing ? existing.id : null;

  superAdmin = await makeAdmin("super");
  await transferSuperAdmin({ targetId: superAdmin.id }); // the test admin holds the role for now

  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));

  // Give the role back to whoever held it, then remove every test admin.
  if (originalSuperId && (await Admin.findByPk(originalSuperId))) {
    await transferSuperAdmin({ targetId: originalSuperId });
  }
  await Admin.destroy({ where: { id: createdIds } });
  await sequelize.close();
});

test("admin management needs an admin token", async () => {
  assert.equal((await call("GET", "/api/admin/admins", { as: null })).status, 401);
  assert.equal((await call("DELETE", "/api/admin/admins/1", { as: null })).status, 401);
  assert.equal((await call("POST", "/api/admin/admins/1/make-super-admin", { as: null })).status, 401);
});

test("only the super admin can create admins; new ones are regular admins", async () => {
  const regular = await makeAdmin("creator");

  const denied = await call("POST", "/api/admin/register", {
    as: regular,
    body: { name: "Nope", email: `nope-${uniqueSuffix}@test.com`, password: PASSWORD, adminPassword: PASSWORD },
  });
  assert.equal(denied.status, 403);

  // The super admin must confirm with their own password; nothing is created without it.
  const newEmail = `created-${uniqueSuffix}@test.com`;
  const fields = { name: "Created", email: newEmail, password: PASSWORD };

  const missing = await call("POST", "/api/admin/register", { as: superAdmin, body: fields });
  assert.equal(missing.status, 400);
  assert.match(missing.body.message, /your password is required/i);

  const wrong = await call("POST", "/api/admin/register", {
    as: superAdmin,
    body: { ...fields, adminPassword: "not-my-password" },
  });
  assert.equal(wrong.status, 400);
  assert.match(wrong.body.message, /incorrect password/i);

  // The new admin's own password must not count as the confirmation.
  const wrongField = await call("POST", "/api/admin/register", {
    as: superAdmin,
    body: { ...fields, password: "NewAdminPass1!", adminPassword: "NewAdminPass1!" },
  });
  assert.equal(wrongField.status, 400);
  assert.equal(await Admin.findOne({ where: { email: newEmail } }), null, "failed attempts create nothing");

  const email = newEmail;
  const created = await call("POST", "/api/admin/register", {
    as: superAdmin,
    body: { ...fields, adminPassword: PASSWORD },
  });
  assert.equal(created.status, 201);
  createdIds.push(created.body.admin.id);
  assert.equal(created.body.admin.role, "admin");

  const list = await call("GET", "/api/admin/admins", { as: regular });
  assert.equal(list.status, 200);
  assert.equal(list.body.data.filter((a) => a.role === "super_admin").length, 1);
  assert.equal(list.body.data.find((a) => a.id === superAdmin.id).role, "super_admin");
  assert.equal(list.body.data.find((a) => a.id === regular.id).isCurrent, true);
  assert.ok(list.body.data.every((a) => !("password" in a) && !("resetPasswordToken" in a)));
});

test("deleting needs the acting admin's own password", async () => {
  const target = await makeAdmin("pw-target");

  const none = await call("DELETE", `/api/admin/admins/${target.id}`, { as: superAdmin });
  assert.equal(none.status, 400);
  assert.match(none.body.message, /password is required/i);

  const wrong = await call("DELETE", `/api/admin/admins/${target.id}`, {
    as: superAdmin,
    body: { password: "not-my-password" },
  });
  assert.equal(wrong.status, 400);
  assert.match(wrong.body.message, /incorrect password/i);
  assert.ok(await Admin.findByPk(target.id), "a failed attempt must not delete anyone");
});

test("the super admin can delete any regular admin, who then loses access at once", async () => {
  const target = await makeAdmin("deleted-by-super");
  assert.equal((await call("GET", "/api/admin/admins", { as: target })).status, 200);

  const deleted = await call("DELETE", `/api/admin/admins/${target.id}`, {
    as: superAdmin,
    body: { password: PASSWORD },
  });
  assert.equal(deleted.status, 200);
  assert.equal((await call("GET", "/api/admin/admins", { as: target })).status, 401);
  assert.equal(
    (await call("DELETE", `/api/admin/admins/${target.id}`, { as: superAdmin, body: { password: PASSWORD } })).status,
    404
  );
});

test("a regular admin can delete only themselves", async () => {
  const actor = await makeAdmin("actor");
  const other = await makeAdmin("other");

  const others = await call("DELETE", `/api/admin/admins/${other.id}`, {
    as: actor,
    body: { password: PASSWORD },
  });
  assert.equal(others.status, 403);
  assert.ok(await Admin.findByPk(other.id));

  const self = await call("DELETE", `/api/admin/admins/${actor.id}`, {
    as: actor,
    body: { password: PASSWORD },
  });
  assert.equal(self.status, 200);
  assert.equal(await Admin.findByPk(actor.id), null);
  assert.equal((await call("GET", "/api/admin/admins", { as: actor })).status, 401);
});

test("the super admin can never be deleted, not even by themselves", async () => {
  const regular = await makeAdmin("wants-super-gone");

  const byRegular = await call("DELETE", `/api/admin/admins/${superAdmin.id}`, {
    as: regular,
    body: { password: PASSWORD },
  });
  assert.equal(byRegular.status, 403);

  const bySelf = await call("DELETE", `/api/admin/admins/${superAdmin.id}`, {
    as: superAdmin,
    body: { password: PASSWORD },
  });
  assert.equal(bySelf.status, 403);
  assert.match(bySelf.body.message, /super admin cannot be deleted/i);
  assert.ok(await Admin.findByPk(superAdmin.id));
});

test("bad ids are rejected", async () => {
  const response = await call("DELETE", "/api/admin/admins/abc", {
    as: superAdmin,
    body: { password: PASSWORD },
  });
  assert.equal(response.status, 400);
});

test("handing over the super admin role keeps exactly one super admin", async () => {
  const successor = await makeAdmin("successor");
  const bystander = await makeAdmin("bystander");

  // Only the super admin can hand it over, with their password.
  assert.equal(
    (await call("POST", `/api/admin/admins/${successor.id}/make-super-admin`, {
      as: bystander,
      body: { password: PASSWORD },
    })).status,
    403
  );
  assert.equal(
    (await call("POST", `/api/admin/admins/${successor.id}/make-super-admin`, { as: superAdmin })).status,
    400
  );
  assert.equal(
    (await call("POST", `/api/admin/admins/${successor.id}/make-super-admin`, {
      as: superAdmin,
      body: { password: "wrong-password" },
    })).status,
    400
  );
  assert.equal(
    (await call("POST", `/api/admin/admins/${superAdmin.id}/make-super-admin`, {
      as: superAdmin,
      body: { password: PASSWORD },
    })).status,
    400,
    "already the super admin"
  );
  assert.equal(
    (await call("POST", "/api/admin/admins/999999999/make-super-admin", {
      as: superAdmin,
      body: { password: PASSWORD },
    })).status,
    404
  );
  assert.equal(await superCount(), 1);

  const done = await call("POST", `/api/admin/admins/${successor.id}/make-super-admin`, {
    as: superAdmin,
    body: { password: PASSWORD },
  });
  assert.equal(done.status, 200);

  const after = await roles();
  assert.equal(after[successor.id], "super_admin");
  assert.equal(after[superAdmin.id], "admin");
  assert.equal(await superCount(), 1);

  // Powers move with the role: the old super admin can no longer create admins, the new one can.
  const body = {
    name: "Late",
    email: `late-${uniqueSuffix}@test.com`,
    password: PASSWORD,
    adminPassword: PASSWORD,
  };
  assert.equal((await call("POST", "/api/admin/register", { as: superAdmin, body })).status, 403);
  const created = await call("POST", "/api/admin/register", { as: successor, body });
  assert.equal(created.status, 201);
  createdIds.push(created.body.admin.id);

  // Hand it back so the remaining tests (and cleanup) start from a known state.
  const back = await call("POST", `/api/admin/admins/${superAdmin.id}/make-super-admin`, {
    as: successor,
    body: { password: PASSWORD },
  });
  assert.equal(back.status, 200);
  assert.equal(await superCount(), 1);
});

test("two simultaneous handovers cannot leave two super admins", async () => {
  const a = await makeAdmin("race-a");
  const b = await makeAdmin("race-b");

  const results = await Promise.allSettled([
    transferSuperAdmin({ targetId: a.id, actingId: superAdmin.id }),
    transferSuperAdmin({ targetId: b.id, actingId: superAdmin.id }),
  ]);

  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(await superCount(), 1);

  // Put the role back on the test super admin for cleanup.
  await transferSuperAdmin({ targetId: superAdmin.id });
  assert.equal((await roles())[superAdmin.id], "super_admin");
});
