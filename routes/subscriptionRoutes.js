const express = require("express");
const router = express.Router();
const subscriptionController = require("../controllers/subscriptionController");
const stripeWebhookController = require("../controllers/stripeWebhookController");
const { verifyToken } = require("../middlewares/authMiddleware");

// Public
router.get("/plans", subscriptionController.getPlans);

// Protected
router.get("/my", verifyToken, subscriptionController.getMySubscription);
router.post("/upgrade", verifyToken, subscriptionController.upgradePlan);

// ⚠️ Stripe Webhook (NO auth, RAW body)
// router.post(
//   "/webhook",
//   express.raw({ type: "application/json" }),
//   stripeWebhookController.handleWebhook
// );

module.exports = router;