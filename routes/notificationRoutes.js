const express = require("express");
const router = express.Router();
const { saveDeviceToken } = require("../models/deviceTokenModel");

router.post("/save-token", async (req, res) => {
  try {
    const { userId, token } = req.body;

    await saveDeviceToken(userId, token);

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;