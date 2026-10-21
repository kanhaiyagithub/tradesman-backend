const fs = require("fs");
const path = require("path");
const TradesmanDetails = require("../models/TradesmanDetails");
const User = require("../models/User");
const TradesType = require("../models/tradesTypeModel");
const { Op } = require("sequelize");
const storageConfig = require("../config/storage");
const storageService = require("../services/storage/storageService");
const { resolveLicenseFiles } = require("../middlewares/privateUploads");
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

/** Adds the trade's licence rule (licenceRequired, licenceLabel) to serialized rows, so the dashboard can say what is expected. */
const withTradeLicence = async (items) => {
  const list = Array.isArray(items) ? items : [items];
  const ids = [...new Set(list.map((item) => item && item.tradeTypeId).filter(Boolean))];
  const trades = ids.length
    ? await TradesType.findAll({ where: { id: ids }, attributes: ["id", "licenceRequired", "licenceLabel"] })
    : [];
  const byId = Object.fromEntries(trades.map((trade) => [trade.id, trade]));
  for (const item of list) {
    if (!item) continue;
    const trade = byId[item.tradeTypeId];
    item.licenceRequired = Boolean(trade && trade.licenceRequired);
    item.licenceLabel = trade && trade.licenceRequired ? trade.licenceLabel : null;
  }
  return items;
};

const parseUserId = (value) => {
  const userId = Number(value);
  return Number.isInteger(userId) && userId > 0 ? userId : null;
};

// The readiness rules live in a service (the subscription auto-approval needs them too); re-exported below.
const { normalizeOptionalString, validateApprovalReadiness } = require("../services/approvalReadiness");
const {
  applyVerificationState,
  isLicenceRequired,
  buildLicenceRequiredLiteral,
} = require("../services/verificationStateService");

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
          "isDummy",
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
    const conditions = [];
    if (status !== "rejected") {
      // Only licence-required trades need an admin to look at them; everyone else is approved automatically.
      conditions.push(buildLicenceRequiredLiteral());
      if (!includeUnsubscribed) conditions.push(buildSubscribedExistsLiteral("`TradesmanDetails`.`userId`"));
    }
    if (conditions.length) whereDetail[Op.and] = conditions;
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
          attributes: ["id", "name", "email", "mobile", "role", "isVerified", "isDummy"],
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
      data: await withTradeLicence(result.rows.map(serializeDetails)),
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

    // Licence details are required only for licence-required trades; a profile photo always.
    const user = await User.findByPk(userId);
    const licenceRequired = await isLicenceRequired(details.tradeTypeId);
    const missingFields = validateApprovalReadiness(details, {
      licenceRequired,
      profileImage: user?.profileImage ?? null,
    });
    if (missingFields.length) {
      return send(res, 400, false, "Tradesman profile is incomplete", {
        missingFields,
      });
    }

    // Approving by hand is the licence check: only a licence-required trade ends up "licence verified".
    await applyVerificationState(details, user, "approved", {
      adminId: req.user.id,
      licenceVerified: licenceRequired,
    });

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

    const user = await User.findByPk(userId);
    await applyVerificationState(details, user, "rejected", { adminId: req.user.id, reason });

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
    return send(res, 200, true, "Fetched", await withTradeLicence(serializeDetails(details)));
  } catch (err) {
    console.error(err);
    return send(res, 500, false, "Server error");
  }
}

// Types that are safe to show inline. Anything else is sent as a download, so an uploaded
// .html/.svg can never run in the browser from this endpoint.
const LICENSE_CONTENT_TYPES = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".jfif": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".pdf": "application/pdf",
};

/**
 * GET /api/admin/tradesmen/:userId/license
 * Streams the tradesman's licence document to an authenticated admin. Licence files are no
 * longer served by URL (see middlewares/privateUploads.js), so this is the only way to read them.
 */
async function getLicense(req, res) {
  try {
    const userId = parseUserId(req.params.userId);
    if (!userId) return send(res, 400, false, "userId must be a positive integer");

    const details = await getTradesmanDetailsForAdmin(userId);
    const notFound = () => send(res, 404, false, "Licence document not found");
    if (!details || !details.licenseDocument) return notFound();

    const key = storageService.normalizeStorageKey(details.licenseDocument, { category: "license" });
    let absolutePath = null;
    for (const candidate of resolveLicenseFiles(storageConfig.local.rootDir, key)) {
      try {
        if ((await fs.promises.stat(candidate)).isFile()) {
          absolutePath = candidate;
          break;
        }
      } catch {
        // not here, try the next allowed location
      }
    }
    if (!absolutePath) return notFound();

    const contentType = LICENSE_CONTENT_TYPES[path.extname(absolutePath).toLowerCase()];
    return res.sendFile(
      absolutePath,
      {
        headers: {
          "Content-Type": contentType || "application/octet-stream",
          "Content-Disposition": contentType ? "inline" : "attachment",
          // Personal data: never cache, and never let the file run anything if it is opened directly.
          "Cache-Control": "private, no-store",
          "Content-Security-Policy": "default-src 'none'; sandbox",
        },
      },
      (error) => {
        if (error && !res.headersSent) send(res, 404, false, "Licence document not found");
      }
    );
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
  getLicense,
  getPendingCount,
  getPending,
  approve,
  reject,
  getOne,
  validateApprovalReadiness,
};
