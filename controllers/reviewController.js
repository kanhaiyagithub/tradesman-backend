// controllers/reviewController.js
const Review = require("../models/reviewModel");
const Hire = require("../models/hireModel");

const MAX_COMMENT_LENGTH = 1000;

exports.addReview = async (req, res) => {
  try {
    const userId = req.user.id;
    const userRole = req.user.role; // "client" | "tradesman"
    const { hireId, rating, comment } = req.body;

    if (!hireId || rating === undefined || rating === null) {
      return res.status(400).json({
        success: false,
        message: "hireId and rating are required"
      });
    }

    const numericRating = Number(rating);

    if (!Number.isInteger(numericRating) || numericRating < 1 || numericRating > 5) {
      return res.status(400).json({
        success: false,
        message: "Rating must be an integer between 1 and 5"
      });
    }

    const hire = await Hire.findByPk(hireId);
    if (!hire) {
      return res.status(404).json({ success: false, message: "Hire not found" });
    }

    if (hire.status !== "completed") {
      return res.status(400).json({ success: false, message: "Job not completed" });
    }

    let fromUserId, toUserId;

    if (userRole === "client") {
      if (hire.clientId !== userId) {
        return res.status(403).json({ success: false, message: "Not allowed" });
      }
      fromUserId = hire.clientId;
      toUserId = hire.tradesmanId;
    } else {
      if (hire.tradesmanId !== userId) {
        return res.status(403).json({ success: false, message: "Not allowed" });
      }
      fromUserId = hire.tradesmanId;
      toUserId = hire.clientId;
    }

    const already = await Review.findOne({
      where: { hireId, fromUserId: userId }
    });

    if (already) {
      return res.status(400).json({ success: false, message: "Review already submitted" });
    }

    const reviewComment = comment ? String(comment).trim() : null;
    if (reviewComment && reviewComment.length > MAX_COMMENT_LENGTH) {
      return res.status(400).json({
        success: false,
        message: `Comment must be ${MAX_COMMENT_LENGTH} characters or less`
      });
    }

    const review = await Review.create({
      hireId,
      fromUserId,
      toUserId,
      rating: numericRating,
      comment: reviewComment,
      role: userRole
    });

    res.json({
      success: true,
      message: userRole === "tradesman"
        ? "Client review submitted successfully"
        : "Tradesman review submitted successfully",
      data: review
    });

  } catch (err) {
    // Two simultaneous submissions: the unique index rejects the second one.
    if (err.name === "SequelizeUniqueConstraintError") {
      return res.status(400).json({ success: false, message: "Review already submitted" });
    }
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};
// GET /api/review/pending
exports.getPendingReviews = async (req, res) => {
  const userId = req.user.id;
  const role = req.user.role;

  const where =
    role === "client"
      ? { clientId: userId, status: "completed" }
      : { tradesmanId: userId, status: "completed" };

  const hires = await Hire.findAll({ where });

  const hireIds = hires.map(h => h.id);

  const givenReviews = await Review.findAll({
    where: { fromUserId: userId }
  });

  const reviewedHireIds = givenReviews.map(r => r.hireId);

  const pending = hires.filter(h => !reviewedHireIds.includes(h.id));

  res.json({ success: true, data: pending });
};

