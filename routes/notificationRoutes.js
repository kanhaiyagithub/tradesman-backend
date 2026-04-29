const express = require("express");
const router = express.Router();

const { saveDeviceToken } = require("../models/deviceTokenModel");
const { verifyToken } = require("../middlewares/authMiddleware");

/**
 * Save the authenticated user's Firebase device token.
 *
 * Notes:
 * - Keeps route-level logs for easier request tracing
 * - Trims the incoming token before saving
 * - Relies on the model helper to avoid duplicate token rows
 *
 * @route POST /save-token
 * @access Private
 */
router.post("/save-token", verifyToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { token } = req.body;

    if (!token || !token.trim()) {
      console.log("[SAVE TOKEN VALIDATION FAILED]", {
        userId,
        reason: "Token is required",
      });

      return res.status(400).json({
        success: false,
        message: "Token is required",
      });
    }

    const sanitizedToken = token.trim();

    await saveDeviceToken(userId, sanitizedToken);

    console.log("[DEVICE TOKEN SAVED]", {
      userId,
      token: sanitizedToken.substring(0, 20) + "...",
    });

    return res.json({
      success: true,
      message: "Device token saved successfully",
    });
  } catch (error) {
    console.error("[SAVE TOKEN ERROR]", {
      message: error.message,
      stack: error.stack,
    });

    return res.status(500).json({
      success: false,
      message: "Failed to save device token",
    });
  }
});

module.exports = router;
