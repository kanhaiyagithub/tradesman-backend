const express = require("express");
const router = express.Router();

const { verifyAdminToken } = require("../../middlewares/adminAuthMiddleware");

const {
  getOverviewStats,
  getAnalytics,
  getSummary
} = require("../../controllers/AdminController/adminDashboardController");

/* Dashboard Summary (all Overview data in one call) */
router.get("/summary", verifyAdminToken, getSummary);

/* Dashboard Overview */
router.get("/overview", verifyAdminToken, getOverviewStats);

/* Dashboard Analytics */
router.get("/analytics", verifyAdminToken, getAnalytics);

module.exports = router;
