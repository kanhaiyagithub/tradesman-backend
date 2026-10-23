// controllers/clientBookingController.js
const Hire = require("../models/hireModel");
const User = require("../models/User");
const Review = require("../models/reviewModel");
const { Op, fn, col } = require("sequelize");
const storageService = require("../services/storage/storageService");

const sendResponse = (res, status, success, message, data = null) =>
  res.status(status).json({ success, message, data });

// "past" now covers every finished hire, not only completed ones.
const PAST_STATUSES = ["completed", "rejected", "cancelled"];
const CURRENT_STATUSES = ["pending", "accepted"];

/**
 * GET /api/hire/client/bookings?type=my|past|all
 *
 * - my   (default): pending + accepted
 * - past: completed + rejected + cancelled
 * - all:  everything
 *
 * Each booking also carries:
 * - myReview: the review this client gave for the hire (or null)
 * - tradesmanRating: the tradesman's overall { avgRating, reviewCount }
 */
exports.getClientBookings = async (req, res) => {
  try {
    const clientId = req.user.id;
    const type = (req.query.type || "my").toLowerCase();

    const where = { clientId };

    // 🔥 Filter as per Figma
    if (type === "my") {
      where.status = { [Op.in]: CURRENT_STATUSES };
    } else if (type === "past") {
      where.status = { [Op.in]: PAST_STATUSES };
    }

    const bookings = await Hire.findAll({
      where,
      include: [
        {
          model: User,
          as: "tradesman",
          attributes: ["id", "name", "profileImage"]
        }
      ],
      order: [["createdAt", "DESC"]]
    });

    const hireIds = bookings.map((job) => job.id);
    const tradesmanIds = [...new Set(bookings.map((job) => job.tradesmanId).filter(Boolean))];

    // Two queries for the whole list (no per-booking lookups).
    const [myReviews, ratingRows] = await Promise.all([
      hireIds.length
        ? Review.findAll({
            where: { hireId: { [Op.in]: hireIds }, fromUserId: clientId },
            attributes: ["id", "hireId", "rating", "comment", "createdAt"],
          })
        : [],
      tradesmanIds.length
        ? Review.findAll({
            attributes: [
              "toUserId",
              [fn("AVG", col("rating")), "avgRating"],
              [fn("COUNT", col("id")), "reviewCount"],
            ],
            where: { toUserId: { [Op.in]: tradesmanIds }, role: "client" },
            group: ["toUserId"],
            raw: true,
          })
        : [],
    ]);

    const reviewByHireId = new Map(myReviews.map((review) => [Number(review.hireId), review]));
    const ratingByTradesmanId = new Map(
      ratingRows.map((row) => [
        Number(row.toUserId),
        {
          avgRating: Number(Number(row.avgRating || 0).toFixed(1)),
          reviewCount: Number(row.reviewCount || 0),
        },
      ])
    );

    // UI friendly mapping
    const mapped = bookings.map((job) => {
      const review = reviewByHireId.get(Number(job.id)) || null;

      return {
        hireId: job.id,
        tradesman: job.tradesman
          ? {
              ...job.tradesman.toJSON(),
              profileImage: storageService.toPublicUrl(job.tradesman.profileImage, {
                category: "profile",
              }),
            }
          : null,
        status: job.status,
        requestCompletion: Boolean(job.requestCompletion),
        jobDescription: job.jobDescription,
        createdAt: job.createdAt,
        canReview: job.status === "completed" && !review,
        myReview: review
          ? {
              id: review.id,
              rating: review.rating,
              comment: review.comment,
              createdAt: review.createdAt,
            }
          : null,
        tradesmanRating: ratingByTradesmanId.get(Number(job.tradesmanId)) || {
          avgRating: 0,
          reviewCount: 0,
        },
      };
    });

    return sendResponse(res, 200, true, "Client bookings fetched", mapped);

  } catch (err) {
    console.error("getClientBookings:", err);
    return sendResponse(res, 500, false, err.message);
  }
};
