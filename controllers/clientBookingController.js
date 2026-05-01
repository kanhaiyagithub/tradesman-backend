// controllers/clientBookingController.js
const Hire = require("../models/hireModel");
const User = require("../models/User");
const { Op } = require("sequelize");
const storageService = require("../services/storage/storageService");

const sendResponse = (res, status, success, message, data = null) =>
  res.status(status).json({ success, message, data });

exports.getClientBookings = async (req, res) => {
  try {
    const clientId = req.user.id;
    const type = (req.query.type || "my").toLowerCase();

    const where = { clientId };

    // 🔥 Filter as per Figma
    if (type === "my") {
      where.status = { [Op.in]: ["pending", "accepted"] };
    } 
    else if (type === "past") {
      where.status = "completed";
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

    // UI friendly mapping
    const mapped = bookings.map((job) => ({
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
      jobDescription: job.jobDescription,
      createdAt: job.createdAt,
      canReview: job.status === "completed"
    }));

    return sendResponse(res, 200, true, "Client bookings fetched", mapped);

  } catch (err) {
    console.error("getClientBookings:", err);
    return sendResponse(res, 500, false, err.message);
  }
};
