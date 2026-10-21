const express = require("express");
const router = express.Router();

const { verifyAdminToken } = require("../../middlewares/adminAuthMiddleware");
const { authRateLimiter } = require("../../middlewares/rateLimitMiddleware");
const controller = require("../../controllers/AdminController/adminDummyUsersController");

// Any admin (not only the super admin) can manage test users.
//
// Reading and deleting are always allowed, even when the feature is switched off, so test data left on a server
// can always be seen and removed. Only creating test users (and giving them new passwords) needs the switch on.
router.get("/status", verifyAdminToken, controller.getDummyUsersStatus);
router.get("/", verifyAdminToken, controller.listDummyUsers);

// Rate limited and password-confirmed: these are heavy, and creation responses carry passwords.
router.post(
  "/",
  authRateLimiter,
  verifyAdminToken,
  controller.requireDummyUsersEnabled,
  controller.createDummyUsers
);
router.post(
  "/:id/password",
  authRateLimiter,
  verifyAdminToken,
  controller.requireDummyUsersEnabled,
  controller.resetDummyUserPassword
);
router.delete("/", authRateLimiter, verifyAdminToken, controller.deleteAllDummyUsers);
router.delete("/:id", authRateLimiter, verifyAdminToken, controller.deleteDummyUser);

module.exports = router;
