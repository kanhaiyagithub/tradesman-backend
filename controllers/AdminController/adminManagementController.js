const bcrypt = require("bcryptjs");
const Admin = require("../../models/AdminModel/adminModel");
const { disconnectAdminSockets } = require("../../services/adminEventService");
const { SuperAdminError, transferSuperAdmin } = require("../../services/superAdminService");

const send = (res, status, success, message, data = null) =>
  res.status(status).json({ success, message, data });

const parseId = (value) => {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
};

const toPublicAdmin = (admin, currentAdminId) => ({
  id: admin.id,
  name: admin.name,
  email: admin.email,
  role: admin.role,
  createdAt: admin.createdAt,
  isCurrent: admin.id === currentAdminId,
});

/**
 * Confirms the acting admin's OWN password. Wrong or missing is a 400 (not 401) so the
 * dashboard does not treat it as an expired session. Returns true when the request may go on.
 */
const confirmActingPassword = async (req, res, missingMessage) => {
  const password = req.body?.password;
  if (typeof password !== "string" || !password) {
    send(res, 400, false, missingMessage);
    return false;
  }

  const actingAdmin = await Admin.findByPk(req.user.id);
  if (!actingAdmin || !(await bcrypt.compare(password, actingAdmin.password))) {
    send(res, 400, false, "Incorrect password");
    return false;
  }
  return true;
};

/**
 * GET /api/admin/admins
 * Every admin account. Passwords and reset fields are never returned. Exactly one admin has
 * role "super_admin". New admins are created with POST /api/admin/register (super admin only).
 */
exports.listAdmins = async (req, res) => {
  try {
    const admins = await Admin.findAll({
      attributes: ["id", "name", "email", "role", "createdAt"],
      order: [["createdAt", "ASC"]],
    });
    return send(res, 200, true, "Admins fetched", admins.map((a) => toPublicAdmin(a, req.user.id)));
  } catch (error) {
    console.error("Admin list error:", error);
    return send(res, 500, false, "Server error");
  }
};

/**
 * DELETE /api/admin/admins/:id   body: { password }
 *   - the acting admin confirms with their own password
 *   - the super admin can never be deleted (by anyone, including themselves)
 *   - the super admin can delete any other admin
 *   - a regular admin can only delete themselves
 * The deleted admin's token stops working immediately (verifyAdminToken looks the admin up on
 * every request) and any open dashboard socket is disconnected.
 */
exports.deleteAdmin = async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return send(res, 400, false, "id must be a positive integer");

    if (!(await confirmActingPassword(req, res, "Your password is required to remove an admin"))) {
      return undefined;
    }

    const admin = await Admin.findByPk(id);
    if (!admin) return send(res, 404, false, "Admin not found");

    if (admin.role === "super_admin") {
      return send(
        res,
        403,
        false,
        "The super admin cannot be deleted. Hand the role to another admin first."
      );
    }

    const isSelf = id === req.user.id;
    if (!isSelf && req.user.role !== "super_admin") {
      return send(res, 403, false, "Only the super admin can remove other admins");
    }

    await admin.destroy();
    await disconnectAdminSockets(id);

    return send(res, 200, true, isSelf ? "Your account was deleted" : "Admin deleted");
  } catch (error) {
    console.error("Admin delete error:", error);
    return send(res, 500, false, "Server error");
  }
};

/**
 * POST /api/admin/admins/:id/make-super-admin   body: { password }
 * Super admin only. The target becomes the super admin and the caller becomes a regular
 * admin (there is only ever one), in a single transaction.
 */
exports.makeSuperAdmin = async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return send(res, 400, false, "id must be a positive integer");

    if (!(await confirmActingPassword(req, res, "Your password is required to hand over the super admin role"))) {
      return undefined;
    }

    try {
      const result = await transferSuperAdmin({ targetId: id, actingId: req.user.id });
      return send(res, 200, true, "Super admin role transferred", { newSuperAdminId: result.newId });
    } catch (error) {
      if (error instanceof SuperAdminError) {
        const status = { NOT_FOUND: 404, NOT_SUPER_ADMIN: 403, ALREADY_SUPER_ADMIN: 400 }[error.code] || 400;
        return send(res, status, false, error.message);
      }
      throw error;
    }
  } catch (error) {
    console.error("Admin super admin transfer error:", error);
    return send(res, 500, false, "Server error");
  }
};
