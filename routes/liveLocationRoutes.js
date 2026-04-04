const express = require("express");
const router = express.Router();
const { verifyToken } = require("../middlewares/authMiddleware");
const { updateLiveLocation } = require("../controllers/liveLocationController");

router.post("/live-update", verifyToken, updateLiveLocation);

module.exports = router;