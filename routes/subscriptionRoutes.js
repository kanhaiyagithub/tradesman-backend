const express = require("express");
const router = express.Router();
const subscriptionController = require("../controllers/subscriptionController");
const { verifyToken } = require("../middlewares/authMiddleware");

// Public
router.get("/plans", subscriptionController.getPlans);
router.get("/success", subscriptionController.successPage);
router.get("/cancel", subscriptionController.cancelPage);

// Protected
router.get("/my", verifyToken, subscriptionController.getMySubscription);
router.post(
  "/checkout-session",
  verifyToken,
  subscriptionController.createCheckoutSession
);
router.post(
  "/upgrade-plan",
  verifyToken,
  subscriptionController.upgradePlan
);
router.post(
  "/downgrade-plan",
  verifyToken,
  subscriptionController.downgradePlan
);

router.post(
  "/mobile/setup-intent",
  verifyToken,
  subscriptionController.createMobileSetupIntent
);

router.post(
  "/mobile/create-subscription",
  verifyToken,
  subscriptionController.createMobileSubscription
);

module.exports = router;