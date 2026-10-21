const bcrypt = require("bcryptjs");
const Admin = require("../../models/AdminModel/adminModel");
const { isDummyUsersEnabled } = require("../../config/dummyUsers");
const {
  DummyUserError,
  parseCreateInput,
  createDummyUsers,
  getStatus,
  listDummyUsers,
  resetDummyPassword,
} = require("../../services/dummyUserService");
const { purgeDummyUsers } = require("../../services/dummyUserPurgeService");

const send = (res, status, success, message, data = null) =>
  res.status(status).json({ success, message, data });

const parseId = (value) => {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
};

/** Maps a service error to its HTTP answer; anything unexpected is a plain 500 with no details. */
const handleError = (res, error, label) => {
  if (error instanceof DummyUserError) return send(res, error.status, false, error.message);
  console.error(`${label}:`, error.message);
  return send(res, 500, false, "Server error");
};

/**
 * The acting admin confirms with their OWN password (`adminPassword`; `password` is the test user's).
 * Wrong or missing is a 400, not a 401, so the dashboard does not treat it as an expired session.
 */
const confirmAdminPassword = async (req, res) => {
  const adminPassword = req.body?.adminPassword;
  if (typeof adminPassword !== "string" || !adminPassword) {
    send(res, 400, false, "Your password is required");
    return false;
  }

  const admin = await Admin.findByPk(req.user.id);
  if (!admin || !(await bcrypt.compare(adminPassword, admin.password))) {
    send(res, 400, false, "Incorrect password");
    return false;
  }
  return true;
};

/** Test users can be switched off per server (see config/dummyUsers.js). */
exports.requireDummyUsersEnabled = (req, res, next) => {
  if (!isDummyUsersEnabled()) {
    return send(res, 403, false, "Test users are turned off on this server");
  }
  return next();
};

/** GET /api/admin/dummy-users/status: always available, so the dashboard knows whether to offer the page. */
exports.getDummyUsersStatus = async (req, res) => {
  try {
    return send(res, 200, true, "Test user status", await getStatus());
  } catch (error) {
    return handleError(res, error, "Dummy users status");
  }
};

/** GET /api/admin/dummy-users?role&search&page&limit */
exports.listDummyUsers = async (req, res) => {
  try {
    const { data, meta } = await listDummyUsers(req.query);
    return res.json({ success: true, message: "Test users fetched", data, meta });
  } catch (error) {
    return handleError(res, error, "Dummy users list");
  }
};

/**
 * POST /api/admin/dummy-users
 * body: { adminPassword, role: "client"|"tradesman", count?, name?, email?, password?,
 *         tradeTypeId?, approval?: "approved"|"pending", subscription?: "active"|"trial"|"expired"|"none",
 *         location?: { latitude, longitude, label }, createAlert?, runMatching? }
 * Responds with the created users INCLUDING their passwords: the only time they can be seen.
 */
exports.createDummyUsers = async (req, res) => {
  try {
    if (!(await confirmAdminPassword(req, res))) return undefined;

    const input = parseCreateInput(req.body);
    const result = await createDummyUsers({ adminId: req.user.id, input });

    res.set("Cache-Control", "no-store"); // the response carries passwords
    return send(
      res,
      201,
      true,
      result.created.length === 1 ? "Test user created" : `${result.created.length} test users created`,
      result,
    );
  } catch (error) {
    return handleError(res, error, "Dummy users create");
  }
};

/**
 * DELETE /api/admin/dummy-users/:id   body: { adminPassword }
 * Removes one test user and everything they own. A real user (or a missing id) is a plain 404 and nothing is touched.
 * Always available, even when creating test users is switched off, so test data can never get stuck.
 */
exports.deleteDummyUser = async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return send(res, 400, false, "id must be a positive integer");
    if (!(await confirmAdminPassword(req, res))) return undefined;

    const result = await purgeDummyUsers({ ids: [id] });
    return send(res, 200, true, "Test user deleted", result);
  } catch (error) {
    return handleError(res, error, "Dummy users delete");
  }
};

/** DELETE /api/admin/dummy-users   body: { adminPassword }: removes EVERY test user. Real users are never touched. */
exports.deleteAllDummyUsers = async (req, res) => {
  try {
    if (!(await confirmAdminPassword(req, res))) return undefined;

    const result = await purgeDummyUsers();
    return send(
      res,
      200,
      true,
      result.deleted === 1 ? "1 test user deleted" : `${result.deleted} test users deleted`,
      result,
    );
  } catch (error) {
    return handleError(res, error, "Dummy users delete all");
  }
};

/** POST /api/admin/dummy-users/:id/password  body: { adminPassword, password? }: a new password, shown once. */
exports.resetDummyUserPassword = async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return send(res, 400, false, "id must be a positive integer");
    if (!(await confirmAdminPassword(req, res))) return undefined;

    const result = await resetDummyPassword({ id, password: req.body?.password });
    res.set("Cache-Control", "no-store");
    return send(res, 200, true, "Password changed", result);
  } catch (error) {
    return handleError(res, error, "Dummy users password");
  }
};
