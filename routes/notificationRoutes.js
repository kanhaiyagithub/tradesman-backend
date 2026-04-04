const express = require("express");
const router = express.Router();

const { saveDeviceToken } = require("../models/deviceTokenModel");
const { verifyToken } = require("../middlewares/authMiddleware");

router.post("/save-token", verifyToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { token } = req.body;

    if (!token || !token.trim()) {
      return res.status(400).json({
        success: false,
        message: "Token is required",
      });
    }

    await saveDeviceToken(userId, token.trim());

    console.log("[DEVICE TOKEN SAVED]", {
      userId,
      token: token.substring(0, 20) + "...",
    });

    res.json({
      success: true,
      message: "Device token saved successfully",
    });
  } catch (error) {
    console.error("[SAVE TOKEN ERROR]", error.message);

    res.status(500).json({
      success: false,
      message: "Failed to save device token",
    });
  }
});

module.exports = router;