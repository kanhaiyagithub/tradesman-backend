const express = require("express");
const router = express.Router();
const hireController = require("../controllers/hireController");
const clientBookingController = require("../controllers/clientBookingController");
const reviewController = require("../controllers/reviewController");
const { verifyToken } = require("../middlewares/authMiddleware");

// Client → send hire request
router.post("/request", verifyToken, hireController.requestHire);

// Tradesman → accept / reject
router.post("/respond", verifyToken, hireController.respondHire);

router.post("/cancel", verifyToken, hireController.cancelHire);

// Tradesman → request job completion
router.post("/request-complete", verifyToken, hireController.requestJobCompletion);

// Client → confirm YES / NO
router.post("/confirm-complete", verifyToken, hireController.confirmJobCompletion);

// ✅ Client → check pending completion (FIXED)
router.get("/pending-complete", verifyToken, hireController.getPendingCompletionStatus);

// Chat → latest hire status
router.get("/status/:userId", verifyToken, hireController.getHireStatusForConversation);

// My jobs
router.get("/my", verifyToken, hireController.getMyJobs);

router.get("/client/bookings", verifyToken, clientBookingController.getClientBookings);

router.post("/review", verifyToken, reviewController.addReview);
router.get("/review/pending", verifyToken, reviewController.getPendingReviews);


module.exports = router;
