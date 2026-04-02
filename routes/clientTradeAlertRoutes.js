const express = require("express");
const router = express.Router();

const clientTradeAlertController = require("../controllers/clientTradeAlertController");
const { verifyToken } = require("../middlewares/authMiddleware");

router.post("/", verifyToken, clientTradeAlertController.createClientTradeAlert);
router.get("/my", verifyToken, clientTradeAlertController.getMyClientTradeAlerts);
router.put("/:id", verifyToken, clientTradeAlertController.updateClientTradeAlert);
router.patch("/:id/toggle", verifyToken, clientTradeAlertController.toggleClientTradeAlert);
router.delete("/:id", verifyToken, clientTradeAlertController.deleteClientTradeAlert);

module.exports = router;