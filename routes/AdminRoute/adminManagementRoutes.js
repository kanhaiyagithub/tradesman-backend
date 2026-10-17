const express = require("express");
const router = express.Router();

const { verifyAdminToken, requireSuperAdmin } = require("../../middlewares/adminAuthMiddleware");
const { authRateLimiter } = require("../../middlewares/rateLimitMiddleware");
const adminManagementController = require("../../controllers/AdminController/adminManagementController");

router.get("/", verifyAdminToken, adminManagementController.listAdmins);

// Rate limited: the password check must not become a way to guess an admin's password.
// Who may delete whom is decided in the controller (super admin: anyone but the super admin;
// regular admin: only themselves).
router.delete("/:id", authRateLimiter, verifyAdminToken, adminManagementController.deleteAdmin);

router.post(
  "/:id/make-super-admin",
  authRateLimiter,
  verifyAdminToken,
  requireSuperAdmin,
  adminManagementController.makeSuperAdmin
);

module.exports = router;
