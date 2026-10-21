const express = require("express");
const router = express.Router();

const { verifyAdminToken } = require("../../middlewares/adminAuthMiddleware");
const adminTradesTypeController = require("../../controllers/AdminController/adminTradesTypeController");

router.get("/", verifyAdminToken, adminTradesTypeController.listTradesTypes);
router.post("/", verifyAdminToken, adminTradesTypeController.createTradesType);
router.get("/:id/licence-impact", verifyAdminToken, adminTradesTypeController.getLicenceImpact);
router.patch("/:id", verifyAdminToken, adminTradesTypeController.updateTradesType);
router.delete("/:id", verifyAdminToken, adminTradesTypeController.deleteTradesType);

module.exports = router;
