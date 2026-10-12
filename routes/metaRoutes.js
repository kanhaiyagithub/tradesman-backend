const express = require("express");
const router = express.Router();
const { verifyToken } = require("../middlewares/authMiddleware");
const { saveAttribution } = require("../controllers/metaController");

/**
 * Save the authenticated user's Meta attribution / device info.
 *
 * @route POST /api/meta/attribution
 * @access Private
 */
router.post("/attribution", verifyToken, saveAttribution);

module.exports = router;
