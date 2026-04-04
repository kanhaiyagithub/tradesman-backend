const express = require("express");
const router = express.Router();
const { verifyToken } = require("../middlewares/authMiddleware");

const {
  getMyAlertMatches,
  getMyRouteMatches,
} = require("../controllers/matchController");

router.get("/my-alerts", verifyToken, getMyAlertMatches);
router.get("/my-route", verifyToken, getMyRouteMatches);

module.exports = router;