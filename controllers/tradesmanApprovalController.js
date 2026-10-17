const TradesmanDetails = require("../models/TradesmanDetails");
const User = require("../models/User");
const { Op } = require("sequelize");
const sequelize = require("../config/db");
const { sendPushNotification } = require("./notificationController");
const { buildSubscribedExistsLiteral } = require("../services/subscriptionAccessService");
const { countAwaitingReview } = require("../services/pendingApprovalsService");
const { publishApprovalsUpdate } = require("../services/adminEventService");
const {
  sendTradesmanApprovedEmail,
  sendTradesmanRejectedEmail,
} = require("../services/emailService");

const send = (res, code, success, message, data = null) =>
  res.status(code).json({ success, message, data });

const parsePagination = (req) => {
  const page = Math.max(parseInt(req.query.page || 1, 10), 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit || 10, 10), 1), 100);
  const offset = (page - 1) * limit;
  return { page, limit, offset };
};

const sanitizeUser = (user) => {
  if (!user) {
    return null;
  }

  const payload = typeof user.toJSON === "function" ? user.toJSON() : user;
  const {
    password,
    resetPasswordToken,
    resetPasswordExpires,
    ...safePayload
  } = payload;

  return safePayload;
};

const serializeDetails = (details) => {
  if (!details) {
    return null;
  }

  const payload = typeof details.toJSON === "function" ? details.toJSON() : details;
  const { User: legacyUser, user, ...detailsPayload } = payload;

  return {
    ...detailsPayload,
    user: sanitizeUser(user || legacyUser),
  };
};

const parseUserId = (value) => {
  const userId = Number(value);
  return Number.isInteger(userId) && userId > 0 ? userId : null;
};

const normalizeOptionalString = (value) => {
  if (value === undefined || value === null) {
    return "";
  }

  return String(value).trim();
};

const hasPortfolioPhotos = (portfolioPhotos) => {
  if (Array.isArray(portfolioPhotos)) {
    return portfolioPhotos.length > 0;
  }

  if (typeof portfolioPhotos === "string") {
    try {
      const parsed = JSON.parse(portfolioPhotos);
      return Array.isArray(parsed) && parsed.length > 0;
    } catch (error) {
      return portfolioPhotos.trim().length > 0;
    }
  }

  return false;
};

const validateApprovalReadiness = (details) => {
  const missing = [];

  if (!details.tradeTypeId) missing.push("tradeTypeId");
  if (!normalizeOptionalString(details.tradeType)) missing.push("tradeType");
  if (!normalizeOptionalString(details.businessName)) missing.push("businessName");
  if (!normalizeOptionalString(details.shortBio)) missing.push("shortBio");
  if (!normalizeOptionalString(details.licenseNumber)) missing.push("licenseNumber");
  if (!details.licenseExpiry) missing.push("licenseExpiry");
  if (!normalizeOptionalString(details.licenseDocument)) missing.push("licenseDocument");
  if (!hasPortfolioPhotos(details.portfolioPhotos)) missing.push("portfolioPhotos");

  return missing;
};

const getTradesmanDetailsForAdmin = async (userId) =>
  TradesmanDetails.findOne({
    where: { userId },
    include: [
      {
        model: User,
        as: "user",
        where: { role: "tradesman" },
        attributes: [
          "id",
          "name",
          "email",
          "mobile",
          "role",
          "isVerified",
          "profileImage",
          "createdAt",
          "updatedAt",
        ],
        required: true,
      },
    ],
  });

async function getPending(req, res) {
  try {
    const { page, limit, offset } = parsePagination(req);
    const { search, tradeType, tradeTypeId } = req.query;

    const { status } = req.query;
    const allowedStatuses = ["pending", "resubmitted", "rejected"];
    if (status && !allowedStatuses.includes(status)) {
      return send(res, 400, false, `status must be one of: ${allowedStatuses.join(", ")}`);
    }

    // Default queue = awaiting review (never reviewed + resubmitted).
    const whereDetail = {
      isApproved: false,
      verificationStatus: status ? status : { [Op.in]: ["pending", "resubmitted"] },
    };

    // Admins only review tradesmen who have subscribed. Pass
    // includeUnsubscribed=true to see everyone; the rejected list is never filtered.
    const includeUnsubscribed = String(req.query.includeUnsubscribed).toLowerCase() === "true";
    if (!includeUnsubscribed && status !== "rejected") {
      whereDetail[Op.and] = [buildSubscribedExistsLiteral("`TradesmanDetails`.`userId`")];
    }
    if (tradeTypeId) {
      const parsedTradeTypeId = Number(tradeTypeId);
      if (!Number.isInteger(parsedTradeTypeId) || parsedTradeTypeId <= 0) {
        return send(res, 400, false, "tradeTypeId must be a positive integer");
      }

      whereDetail.tradeTypeId = parsedTradeTypeId;
    } else if (tradeType) {
      whereDetail.tradeType = tradeType;
    }

    const userWhere = { role: "tradesman" };
    if (search) {
      userWhere[Op.or] = [
        { name: { [Op.like]: `%${search}%` } },
        { email: { [Op.like]: `%${search}%` } },
      ];
    }

    const result = await TradesmanDetails.findAndCountAll({
      where: whereDetail,
      include: [
        {
          model: User,
          as: "user",
          attributes: ["id", "name", "email", "mobile", "role", "isVerified"],
          where: userWhere,
          required: true,
        },
      ],
      order: [
        [
          sequelize.literal("CASE WHEN `TradesmanDetails`.`verificationStatus` = 'resubmitted' THEN 0 ELSE 1 END"),
          "ASC",
        ],
        ["createdAt", "DESC"],
      ],
      limit,
      offset,
    });

    return send(res, 200, true, "Pending tradesmen fetched", {
      meta: { total: result.count, page, perPage: limit },
      data: result.rows.map(serializeDetails),
    });
  } catch (err) {
    console.error(err);
    return send(res, 500, false, "Server error");
  }
}

async function approve(req, res) {
  try {
    const userId = parseUserId(req.params.userId);
    if (!userId) {
      return send(res, 400, false, "userId must be a positive integer");
    }

    const details = await getTradesmanDetailsForAdmin(userId);
    if (!details) return send(res, 404, false, "Tradesman details not found");

    if (details.isApproved) {
      return send(res, 400, false, "Tradesman is already approved");
    }

    if (details.verificationStatus === "rejected") {
      return send(
        res,
        400,
        false,
        "Tradesman was rejected and must resubmit their profile before it can be approved"
      );
    }

    const missingFields = validateApprovalReadiness(details);
    if (missingFields.length) {
      return send(res, 400, false, "Tradesman profile is incomplete", {
        missingFields,
      });
    }

    details.isApproved = true;
    details.verificationStatus = "approved";
    details.approvedBy = req.user.id;
    details.approvedAt = new Date();
    details.rejectionReason = null;
    await details.save();

    const user = await User.findByPk(userId);
    if (user && "isVerified" in user) {
      user.isVerified = true;
      await user.save();
    }

    sendPushNotification(
      userId,
      "Profile Approved",
      "Congratulations! Your tradesman profile has been approved. You can now start receiving hire requests.",
      { type: "PROFILE_APPROVED" }
    );

    // Fire-and-forget: sendTradesmanApprovedEmail never throws or blocks the response.
    sendTradesmanApprovedEmail({ user, businessName: details.businessName });

    // Keep other admins' queue badge in sync (never throws).
    publishApprovalsUpdate({ type: "decided" });

    return send(res, 200, true, "Tradesman approved", {
      user: sanitizeUser(user),
      details: serializeDetails(details),
    });
  } catch (err) {
    console.error(err);
    return send(res, 500, false, "Server error");
  }
}

async function reject(req, res) {
  try {
    const userId = parseUserId(req.params.userId);
    if (!userId) {
      return send(res, 400, false, "userId must be a positive integer");
    }

    const reason = normalizeOptionalString(req.body?.reason);
    if (!reason) {
      return send(res, 400, false, "Rejection reason is required");
    }

    if (reason.length > 500) {
      return send(res, 400, false, "Rejection reason must be 500 characters or less");
    }

    const details = await getTradesmanDetailsForAdmin(userId);
    if (!details) return send(res, 404, false, "Tradesman details not found");

    if (details.isApproved) {
      return send(res, 400, false, "Approved tradesmen cannot be rejected from this endpoint");
    }

    if (details.verificationStatus === "rejected") {
      return send(res, 400, false, "Tradesman is already rejected and awaiting resubmission");
    }

    details.isApproved = false;
    details.verificationStatus = "rejected";
    details.rejectionReason = reason;
    details.approvedBy = req.user.id;
    details.approvedAt = new Date();
    await details.save();

    const user = await User.findByPk(userId);
    if (user && "isVerified" in user) {
      user.isVerified = false;
      await user.save();
    }

    sendPushNotification(
      userId,
      "Profile Update",
      `Your tradesman application was not approved. Reason: ${reason}`,
      { type: "PROFILE_REJECTED", reason }
    );

    // Fire-and-forget: sendTradesmanRejectedEmail never throws or blocks the response.
    sendTradesmanRejectedEmail({ user, reason, rejectedAt: details.approvedAt });

    // Keep other admins' queue badge in sync (never throws).
    publishApprovalsUpdate({ type: "decided" });

    return send(res, 200, true, "Tradesman rejected", {
      user: sanitizeUser(user),
      details: serializeDetails(details),
    });
  } catch (err) {
    console.error(err);
    return send(res, 500, false, "Server error");
  }
}

async function getOne(req, res) {
  try {
    const userId = parseUserId(req.params.userId);
    if (!userId) {
      return send(res, 400, false, "userId must be a positive integer");
    }

    const details = await getTradesmanDetailsForAdmin(userId);

    if (!details) return send(res, 404, false, "Not found");
    return send(res, 200, true, "Fetched", serializeDetails(details));
  } catch (err) {
    console.error(err);
    return send(res, 500, false, "Server error");
  }
}

/**
 * GET /api/admin/tradesmen/pending-count
 * Cheap size of the review queue, for the dashboard badge.
 */
async function getPendingCount(req, res) {
  try {
    const { total, pending, resubmitted } = await countAwaitingReview();
    return send(res, 200, true, "Pending count fetched", {
      count: total,
      pending,
      resubmitted,
    });
  } catch (err) {
    console.error(err);
    return send(res, 500, false, "Server error");
  }
}

module.exports = {
  getPendingCount,
  getPending,
  approve,
  reject,
  getOne,
  validateApprovalReadiness,
};
