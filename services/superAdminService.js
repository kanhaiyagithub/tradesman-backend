const sequelize = require("../config/db");
const Admin = require("../models/AdminModel/adminModel");

class SuperAdminError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SuperAdminError";
    this.code = code; // NOT_FOUND | NOT_SUPER_ADMIN | ALREADY_SUPER_ADMIN
  }
}

/**
 * Hands the super admin role to `targetId`; the previous super admin becomes a regular admin.
 * Runs in one transaction with the admin rows locked, so two simultaneous handovers cannot
 * leave two (or zero) super admins. The previous holder is demoted first because the database
 * only allows one super admin at a time.
 *
 * `actingId`: when given, that admin must be the current super admin (API use). Omit it for the
 * command-line script, which can assign the role regardless of who holds it.
 */
const transferSuperAdmin = ({ targetId, actingId = null }) =>
  sequelize.transaction(async (transaction) => {
    const admins = await Admin.findAll({ transaction, lock: transaction.LOCK.UPDATE });

    const target = admins.find((admin) => admin.id === Number(targetId));
    if (!target) throw new SuperAdminError("NOT_FOUND", "Admin not found");

    const current = admins.find((admin) => admin.role === "super_admin") || null;

    if (actingId !== null && (!current || current.id !== Number(actingId))) {
      throw new SuperAdminError("NOT_SUPER_ADMIN", "Only the super admin can do this");
    }
    if (current && current.id === target.id) {
      throw new SuperAdminError("ALREADY_SUPER_ADMIN", "That admin is already the super admin");
    }

    if (current) await current.update({ role: "admin" }, { transaction });
    await target.update({ role: "super_admin" }, { transaction });

    return { previousId: current ? current.id : null, newId: target.id };
  });

module.exports = { SuperAdminError, transferSuperAdmin };
