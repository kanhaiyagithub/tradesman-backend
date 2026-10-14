const User = require("../models/User");
const TradesmanDetails = require("../models/TradesmanDetails");
const Hire = require("../models/hireModel");
const Message = require("../models/messageModel");
const Review = require("../models/reviewModel");
const TravelPlan = require("../models/locationModel");
const TradesType = require("../models/tradesTypeModel");
const storageService = require("../services/storage/storageService");
const metaConversionService = require("../services/metaConversionService");
const {
  passwordFingerprint,
  signRefreshToken,
  verifyRefreshToken,
} = require("../utils/authTokens");
const { ACTIVE_TRAVEL_PLAN_STATUSES } = require("../services/travelPlanStatusService");
const { getLegCandidates } = require("../services/travelAlertService");

const DEFAULT_FILTER_RADIUS_KM = 15;
// Upper limit for an app-supplied radiusKm.
const MAX_FILTER_RADIUS_KM = 100;
// Upper limit for the optional `limit` of the filter endpoint.
const MAX_FILTER_PAGE_SIZE = 100;

const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Op, fn, col, literal } = require("sequelize");
const crypto = require("crypto");
const transporter = require("../config/email");
require("dotenv").config();

const distanceFormula = (lat, lng) => `
  (6371 * acos(
    cos(radians(${lat})) *
    cos(radians(latitude)) *
    cos(radians(longitude) - radians(${lng})) +
    sin(radians(${lat})) *
    sin(radians(latitude))
  ))
`;

const sendResponse = (
  res,
  statusCode,
  success,
  message,
  data = null,
  error = null,
) => {
  return res.status(statusCode).json({ success, message, data, error });
};

const sanitizeUserPayload = (userPayload) => {
  if (!userPayload) {
    return null;
  }

  const {
    password,
    resetPasswordToken,
    resetPasswordExpires,
    ...safePayload
  } = userPayload;

  return safePayload;
};

/**
 * Resolves a stored profile image key or legacy value into a public URL.
 *
 * @param {string|null|undefined} value - Stored value from the database.
 * @returns {string|null} Public URL.
 */
const toPublicProfileImage = (value) =>
  storageService.toPublicUrl(value, { category: "profile" });

/**
 * Resolves a stored license document key or legacy value into a public URL.
 *
 * @param {string|null|undefined} value - Stored value from the database.
 * @returns {string|null} Public URL.
 */
const toPublicLicenseDocument = (value) =>
  storageService.toPublicUrl(value, { category: "license" });

/**
 * Resolves stored portfolio image keys or legacy values into public URLs.
 *
 * @param {string[]|null|undefined} values - Stored values from the database.
 * @returns {string[]} Public URLs.
 */
const toPublicPortfolioPhotos = (values) =>
  storageService.toPublicUrls(values, { category: "portfolio" });

/**
 * Normalizes user media fields for API responses without changing the database
 * shape stored internally.
 *
 * @param {object|null|undefined} userPayload - Plain user payload.
 * @returns {object|null} User payload with resolved media URLs.
 */
const serializeUserMedia = (userPayload) => {
  if (!userPayload) {
    return null;
  }

  const safePayload = sanitizeUserPayload(userPayload);

  return {
    ...safePayload,
    profileImage: toPublicProfileImage(safePayload.profileImage),
  };
};

/**
 * Normalizes tradesman media fields for API responses.
 *
 * @param {object|null|undefined} tradesmanPayload - Plain tradesman payload.
 * @returns {object|null} Tradesman payload with resolved media URLs.
 */
const serializeTradesmanMedia = (tradesmanPayload) => {
  if (!tradesmanPayload) {
    return null;
  }

  return {
    ...tradesmanPayload,
    licenseDocument: toPublicLicenseDocument(tradesmanPayload.licenseDocument),
    portfolioPhotos: toPublicPortfolioPhotos(tradesmanPayload.portfolioPhotos),
  };
};

/**
 * Normalizes nested user + tradesman responses.
 *
 * @param {object|null|undefined} payload - Plain API payload.
 * @returns {object|null} Payload with resolved media URLs.
 */
const serializeUserWithTradesman = (payload) => {
  if (!payload) {
    return null;
  }

  const nextPayload = serializeUserMedia(payload);

  if (nextPayload.TradesmanDetail) {
    nextPayload.TradesmanDetail = serializeTradesmanMedia(
      nextPayload.TradesmanDetail
    );
  }

  if (nextPayload.tradesman) {
    nextPayload.tradesman = serializeTradesmanMedia(nextPayload.tradesman);
  }

  if (nextPayload.user) {
    nextPayload.user = serializeUserMedia(nextPayload.user);
  }

  return nextPayload;
};


const serializeReview = (reviewPayload, reviewerPayload = null) => ({
  id: reviewPayload.id,
  hireId: reviewPayload.hireId,
  rating: reviewPayload.rating,
  comment: reviewPayload.comment,
  role: reviewPayload.role,
  fromUserId: reviewPayload.fromUserId,
  toUserId: reviewPayload.toUserId,
  fromUser: reviewerPayload
    ? serializeUserMedia({
        id: reviewerPayload.id,
        name: reviewerPayload.name,
        role: reviewerPayload.role,
        profileImage: reviewerPayload.profileImage,
      })
    : null,
  createdAt: reviewPayload.createdAt,
  updatedAt: reviewPayload.updatedAt,
});

const getUserReceivedReviewSummary = async (userId) => {
  const receivedReviews = await Review.findAll({
    where: { toUserId: userId },
    attributes: [
      "id",
      "hireId",
      "fromUserId",
      "toUserId",
      "rating",
      "comment",
      "role",
      "createdAt",
      "updatedAt",
    ],
    order: [["createdAt", "DESC"]],
  });

  const reviewerIds = [
    ...new Set(receivedReviews.map((review) => review.fromUserId).filter(Boolean)),
  ];

  const reviewers = reviewerIds.length
    ? await User.findAll({
        where: { id: { [Op.in]: reviewerIds } },
        attributes: ["id", "name", "role", "profileImage"],
      })
    : [];

  const reviewerById = reviewers.reduce((map, reviewer) => {
    map[reviewer.id] = reviewer.toJSON();
    return map;
  }, {});

  const reviews = receivedReviews.map((review) => {
    const reviewJson = review.toJSON();
    return serializeReview(reviewJson, reviewerById[reviewJson.fromUserId]);
  });

  const avgRating = reviews.length
    ? (
        reviews.reduce((sum, review) => sum + Number(review.rating || 0), 0) /
        reviews.length
      ).toFixed(1)
    : "0.0";

  return {
    rating: avgRating,
    reviewCount: reviews.length,
    reviews,
  };
};

const signToken = (user) => {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: "7d" },
  );
};

/**
 * POST /api/users/refresh-token
 * Exchanges a valid refresh token for a new access token (and a new refresh
 * token). Fails with 401 + code TOKEN_EXPIRED / TOKEN_INVALID otherwise.
 */
exports.refreshToken = async (req, res) => {
  try {
    const refreshToken = req.body?.refreshToken;

    if (!refreshToken || typeof refreshToken !== "string") {
      return res.status(400).json({
        success: false,
        message: "refreshToken is required",
        code: "REFRESH_TOKEN_MISSING",
      });
    }

    let decoded;
    try {
      decoded = verifyRefreshToken(refreshToken);
    } catch (error) {
      const expired = error.name === "TokenExpiredError";
      return res.status(401).json({
        success: false,
        message: expired ? "Refresh token expired" : "Invalid refresh token",
        code: expired ? "TOKEN_EXPIRED" : "TOKEN_INVALID",
      });
    }

    const user = await User.findByPk(decoded.id);

    // A changed/reset password invalidates every refresh token issued before it.
    if (!user || decoded.pv !== passwordFingerprint(user)) {
      return res.status(401).json({
        success: false,
        message: "Invalid refresh token",
        code: "TOKEN_INVALID",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Token refreshed",
      data: {
        token: signToken(user),
        refreshToken: signRefreshToken(user),
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
        },
      },
    });
  } catch (error) {
    console.error("Refresh Token Error:", error);
    return sendResponse(res, 500, false, "Server error");
  }
};

const PASSWORD_RESET_OTP_TTL_MS = 10 * 60 * 1000;
const PASSWORD_RESET_TOKEN_TTL_MS = 15 * 60 * 1000;
const PASSWORD_RESET_OTP_PREFIX = "otp:";
const PASSWORD_RESET_TOKEN_PREFIX = "reset:";

const normalizeEmail = (email) => String(email || "").trim().toLowerCase();

const generatePasswordResetOtp = () =>
  String(crypto.randomInt(100000, 1000000));

const hashPasswordResetSecret = (value) =>
  crypto.createHash("sha256").update(String(value)).digest("hex");

const buildPasswordResetOtpEmail = ({ name, otp }) => {
  const displayName = name || "there";
  const expiryMinutes = Math.floor(PASSWORD_RESET_OTP_TTL_MS / 60 / 1000);

  return {
    subject: "Your Touring Trades password reset code",
    text: [
      `Hi ${displayName},`,
      "",
      `Your Touring Trades password reset code is ${otp}.`,
      `This code expires in ${expiryMinutes} minutes.`,
      "",
      "If you did not request a password reset, you can safely ignore this email.",
      "",
      "Thanks,",
      "The Touring Trades Team",
    ].join("\n"),
    html: `
      <div style="font-family: Arial, sans-serif; color: #1f2937; line-height: 1.5;">
        <p>Hi ${displayName},</p>
        <p>Use the verification code below to reset your Touring Trades password.</p>
        <p style="font-size: 28px; letter-spacing: 6px; font-weight: 700; margin: 24px 0;">${otp}</p>
        <p>This code expires in ${expiryMinutes} minutes.</p>
        <p>If you did not request a password reset, you can safely ignore this email.</p>
        <p>Thanks,<br />The Touring Trades Team</p>
      </div>
    `,
  };
};

/**
 * Helper to parse pagination query params
 */
const parsePagination = (req) => {
  let page = parseInt(req.query.page, 10) || 1;
  let limit = parseInt(req.query.limit, 10) || 10;
  const maxLimit = 100;

  if (page < 1) page = 1;
  if (limit < 1) limit = 10;
  if (limit > maxLimit) limit = maxLimit;

  const offset = (page - 1) * limit;
  return { page, limit, offset };
};

/**
 * Helper to shape paginated response
 */
const paginatedResponse = (res, message, result, page, limit) => {
  const total = result.count ?? (Array.isArray(result) ? result.length : 0);
  const rows = result.rows ?? result;
  const totalPages = limit ? Math.ceil(total / limit) : 1;

  return sendResponse(res, 200, true, message, {
    meta: {
      total,
      page,
      perPage: limit,
      totalPages,
    },
    data: rows,
  });
};

const getDistanceKm = (lat1, lon1, lat2, lon2) => {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

const parseFilterInput = (req) => {
  return req.method === "POST" ? { ...req.query, ...(req.body || {}) } : req.query;
};

const normalizeTradeTypeIds = (input) => {
  if (input === undefined || input === null || input === "") return [];

  const values = Array.isArray(input)
    ? input
    : String(input)
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);

  const ids = values.map((item) => Number(item));

  if (ids.some((item) => Number.isNaN(item))) {
    return null;
  }

  return [...new Set(ids)];
};

const normalizeDateOrNull = (value) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const hasCoordinate = (value) =>
  value !== null &&
  value !== undefined &&
  value !== "" &&
  Number.isFinite(Number(value));

/**
 * Every place a tradesman is or will be on a travel plan, for location search:
 * the current position, the destination and any intermediate stops. Searching
 * used to look at stops only, so a plan without stops (the common case) never
 * matched a location search.
 *
 * Dates (used by the date-range filter): the current position counts from the
 * plan start, the destination at the destination time, stops at their own time.
 */
const getRoutePointsFromTravelPlan = (travelPlan) => {
  if (!travelPlan) return [];

  const points = [
    {
      name: travelPlan.currentLocation || "Current location",
      latitude: travelPlan.latitude,
      longitude: travelPlan.longitude,
      expectedDateTime: travelPlan.startDateTime || null,
    },
    {
      name: travelPlan.destination || "Destination",
      latitude: travelPlan.destinationLatitude,
      longitude: travelPlan.destinationLongitude,
      expectedDateTime: travelPlan.destinationDateTime || null,
    },
  ];

  if (travelPlan.allowStops && Array.isArray(travelPlan.stops)) {
    for (const stop of travelPlan.stops) {
      if (!stop || typeof stop !== "object") continue;
      points.push({
        name: stop.name || "Stop",
        latitude: stop.latitude,
        longitude: stop.longitude,
        expectedDateTime: stop.expectedDateTime || null,
      });
    }
  }

  return points
    .filter((point) => hasCoordinate(point.latitude) && hasCoordinate(point.longitude))
    .map((point) => ({
      ...point,
      latitude: Number(point.latitude),
      longitude: Number(point.longitude),
    }));
};

/**
 * Route points in travel order (start, stops, destination), for working out
 * where the tradesman passes *between* them.
 */
const getOrderedRoutePointsFromTravelPlan = (travelPlan) => {
  if (!travelPlan) return [];

  const stops =
    travelPlan.allowStops && Array.isArray(travelPlan.stops) ? travelPlan.stops : [];

  return [
    {
      name: travelPlan.startLocation || travelPlan.currentLocation || "Start",
      latitude: travelPlan.latitude,
      longitude: travelPlan.longitude,
      expectedDateTime: travelPlan.startDateTime || null,
    },
    ...stops
      .filter((stop) => stop && typeof stop === "object")
      .map((stop) => ({
        name: stop.name || "Stop",
        latitude: stop.latitude,
        longitude: stop.longitude,
        expectedDateTime: stop.expectedDateTime || null,
      })),
    {
      name: travelPlan.destination || "Destination",
      latitude: travelPlan.destinationLatitude,
      longitude: travelPlan.destinationLongitude,
      expectedDateTime: travelPlan.destinationDateTime || null,
    },
  ]
    .filter((point) => hasCoordinate(point.latitude) && hasCoordinate(point.longitude))
    .map((point) => ({
      ...point,
      latitude: Number(point.latitude),
      longitude: Number(point.longitude),
    }));
};

const isStopWithinDateRange = (stop, startDate, endDate) => {
  if (!startDate && !endDate) return true;
  if (!stop?.expectedDateTime) return false;

  const stopTime = new Date(stop.expectedDateTime).getTime();
  if (Number.isNaN(stopTime)) return false;

  if (startDate && stopTime < startDate.getTime()) return false;
  if (endDate && stopTime > endDate.getTime()) return false;

  return true;
};

exports.register = async (req, res) => {
  try {
    const {
      name,
      email,
      mobile,
      password,
      role, // "tradesman" | "client"

      // Tradesman-only text fields
      tradeType,
      tradeTypeId,
      businessName,
      shortBio,
      licenseNumber,
      licenseExpiry,
      portfolioDescription,
    } = req.body;

    // 👇 Files from multer
    const profileImageFile = req.files?.profileImage?.[0] || null;
    const licenseDocFile = req.files?.licenseDocument?.[0] || null;
    const portfolioFiles = req.files?.portfolioPhotos || [];

    // 1) Email already exist?
    const isExist = await User.findOne({ where: { email } });
    if (isExist) {
      return sendResponse(res, 400, false, "User already exists");
    }

    // 2) Tradesman required fields + files
    if (role === "tradesman") {
      if (!tradeTypeId || !businessName || !shortBio) {
        return sendResponse(
          res,
          400,
          false,
          "tradeTypeId, businessName, shortBio required for tradesman",
        );
      }
      if (!licenseNumber || !licenseExpiry) {
        return sendResponse(
          res,
          400,
          false,
          "licenseNumber & licenseExpiry required for tradesman",
        );
      }
      if (!profileImageFile) {
        return sendResponse(
          res,
          400,
          false,
          "profileImage file is required for tradesman",
        );
      }
      if (!licenseDocFile) {
        return sendResponse(
          res,
          400,
          false,
          "licenseDocument file is required for tradesman",
        );
      }
      if (!portfolioFiles.length) {
        return sendResponse(
          res,
          400,
          false,
          "At least one portfolioPhotos file is required for tradesman",
        );
      }
    }

    // 3) Password hash
    const hashedPass = await bcrypt.hash(password, 10);
    let resolvedTradeType = tradeType ? String(tradeType).trim() : null;

    if (role === "tradesman") {
      const tradeRecord = await TradesType.findOne({
        where: { id: Number(tradeTypeId), isActive: true },
      });

      if (!tradeRecord) {
        return sendResponse(res, 400, false, "Invalid tradeTypeId");
      }

      resolvedTradeType = tradeRecord.name;
    }

    const savedProfileImageKey = await storageService.saveSingleImage({
      file: profileImageFile,
      category: "profile",
    });

    // 4) User create (profileImage = normalized storage key)
    const user = await User.create({
      name,
      email,
      mobile,
      password: hashedPass,
      role,
      profileImage: savedProfileImageKey,
    });

    // 5) TradesmanDetails create (licenseDocument + portfolioPhotos array)
    if (role === "tradesman") {
      const savedLicenseDocumentKey = await storageService.saveSingleImage({
        file: licenseDocFile,
        category: "license",
      });
      const portfolioPhotos = await storageService.saveMultipleImages({
        files: portfolioFiles,
        category: "portfolio",
      });

      await TradesmanDetails.create({
        userId: user.id,
        tradeType: resolvedTradeType,
        tradeTypeId: Number(tradeTypeId),
        businessName,
        shortBio,
        licenseNumber,
        licenseExpiry,
        licenseDocument: savedLicenseDocumentKey,
        portfolioPhotos,
        portfolioDescription,
      });

      // // 6) Default subscription: Free Trial
      // const freePlan = await SubscriptionPlan.findOne({
      //   where: { isDefault: true },
      // });

      // if (freePlan) {
      //   await UserSubscription.create({
      //     userId: user.id,
      //     planId: freePlan.id,
      //     startDate: new Date(),
      //     status: "active",
      //   });
      // }
    }

    // Meta Conversions API: never throws and never blocks signup.
    await metaConversionService.trackRegistration({
      user,
      method: "email",
      metaAttribution: req.body.metaAttribution,
      ip: req.ip,
      userAgent: req.get("User-Agent"),
    });

    return sendResponse(
      res,
      201,
      true,
      "User registered successfully",
      serializeUserMedia(user.toJSON())
    );
  } catch (error) {
    console.error("Register Error:", error);
    return sendResponse(res, 500, false, "Server error");
  }
};

exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ where: { email } });
    if (!user) {
      return res.status(400).json({
        success: false,
        message: "Invalid email or password",
        code: "INVALID_CREDENTIALS",
      });
    }

    if (!user.password) {
      return res.status(400).json({
        success: false,
        message: "Please continue with Google login",
        code: "GOOGLE_ACCOUNT",
      });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({
        success: false,
        message: "Invalid email or password",
        code: "INVALID_CREDENTIALS",
      });
    }

    const token = signToken(user);

    return res.status(200).json({
      success: true,
      message: "Login successful",
      data: {
        token,
        refreshToken: signRefreshToken(user),
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
        },
      },
    });
  } catch (error) {
    console.error("Login Error:", error);
    return sendResponse(res, 500, false, "Server error");
  }
};

/**
 * Average rating and review count for many users with ONE grouped query.
 *
 * @param {number[]} userIds - Reviewed user ids.
 * @returns {Promise<Record<number, {avgRating: number, reviewCount: number}>>}
 */
const getRatingSummaryMap = async (userIds) => {
  const ids = [...new Set((userIds || []).map(Number).filter(Boolean))];
  if (!ids.length) return {};

  const ratingRows = await Review.findAll({
    attributes: [
      "toUserId",
      [fn("AVG", col("rating")), "avgRating"],
      [fn("COUNT", col("id")), "reviewCount"],
    ],
    where: { toUserId: { [Op.in]: ids } },
    group: ["toUserId"],
    raw: true,
  });

  return Object.fromEntries(
    ratingRows.map((item) => [
      Number(item.toUserId),
      {
        avgRating: Number(Number(item.avgRating || 0).toFixed(1)),
        reviewCount: Number(item.reviewCount || 0),
      },
    ])
  );
};

/**
 * The ONLY shape the public/directory endpoints return for a user. It never
 * includes contact details (email, mobile), Google IDs, licence fields or
 * approval fields.
 *
 * Tradesmen: id, name, role, profileImage, tradeType, tradeTypeId,
 * businessName, shortBio, avgRating, reviewCount, isVerified (= approved).
 * Everyone else: id, name, role, profileImage.
 *
 * `TradesmanDetail` is kept as a small nested object (same safe fields) so
 * clients that read the old nested shape keep working.
 *
 * @param {object} userJson - Plain user (with optional TradesmanDetail).
 * @param {{avgRating: number, reviewCount: number}} [ratingSummary]
 */
const toPublicUserProfile = (userJson, ratingSummary) => {
  const publicProfile = {
    id: userJson.id,
    name: userJson.name,
    role: userJson.role,
    profileImage: toPublicProfileImage(userJson.profileImage),
  };

  if (userJson.role !== "tradesman") {
    return publicProfile;
  }

  const detail = userJson.TradesmanDetail || null;
  const summary = ratingSummary || { avgRating: 0, reviewCount: 0 };

  return {
    ...publicProfile,
    tradeTypeId: detail?.tradeTypeId || null,
    tradeType: detail?.tradeType || null,
    businessName: detail?.businessName || null,
    shortBio: detail?.shortBio || null,
    avgRating: summary.avgRating,
    reviewCount: summary.reviewCount,
    isVerified: Boolean(detail?.isApproved),
    TradesmanDetail: detail
      ? {
          tradeTypeId: detail.tradeTypeId || null,
          tradeType: detail.tradeType || null,
          businessName: detail.businessName || null,
          shortBio: detail.shortBio || null,
        }
      : null,
  };
};

/**
 * GET /api/users   (requires login)
 * Supports pagination and optional search & role filter:
 * ?page=1&limit=10&search=deepak&role=tradesman
 *
 * Returns the public profile shape only. Search matches the name only, so the
 * endpoint cannot be used to look up people by email or phone number.
 */
exports.getAllUsers = async (req, res) => {
  try {
    const { page, limit, offset } = parsePagination(req);
    const { search, role } = req.query;

    const where = {};
    if (role) where.role = role;

    if (search) {
      where.name = { [Op.like]: `%${search}%` };
    }

    // use findAndCountAll for pagination metadata
    const result = await User.findAndCountAll({
      where,
      attributes: ["id", "name", "role", "profileImage"],
      include: [
        {
          model: TradesmanDetails,
          as: "TradesmanDetail",
          attributes: ["tradeTypeId", "tradeType", "businessName", "shortBio", "isApproved"],
        },
      ],
      limit,
      offset,
      order: [["createdAt", "DESC"]],
    });

    const ratingMap = await getRatingSummaryMap(
      result.rows.filter((row) => row.role === "tradesman").map((row) => row.id)
    );

    result.rows = result.rows.map((row) =>
      toPublicUserProfile(row.toJSON(), ratingMap[row.id])
    );

    return paginatedResponse(res, "Users fetched", result, page, limit);
  } catch (error) {
    console.error("Fetch Users Error:", error);
    return sendResponse(res, 500, false, "Server error");
  }
};

/**
 * GET /api/users/tradesmen
 * Public: lists APPROVED tradesmen (public profile shape only)
 * Supports pagination: ?page=1&limit=10
 * Optional filter: tradeType (e.g. ?tradeType=plumber)
 */
exports.getAllTradesmen = async (req, res) => {
  try {
    const { page, limit, offset } = parsePagination(req);
    const { tradeTypeId, tradeType, search } = req.query;

    const whereUser = { role: "tradesman" };

    // Search on the public name only (never email or mobile)
    if (search) {
      whereUser.name = { [Op.like]: `%${search}%` };
    }

    // Only approved tradesmen are listed, like the filter endpoint
    const tradesmanWhere = { isApproved: true };

    if (
      tradeTypeId !== undefined &&
      tradeTypeId !== null &&
      tradeTypeId !== ""
    ) {
      if (Number.isNaN(Number(tradeTypeId))) {
        return sendResponse(
          res,
          400,
          false,
          "tradeTypeId must be a valid number",
        );
      }
      tradesmanWhere.tradeTypeId = Number(tradeTypeId);
    } else if (tradeType) {
      tradesmanWhere.tradeType = tradeType;
    }

    const result = await User.findAndCountAll({
      where: whereUser,
      attributes: ["id", "name", "role", "profileImage"],
      include: [
        {
          model: TradesmanDetails,
          as: "TradesmanDetail",
          attributes: ["tradeTypeId", "tradeType", "businessName", "shortBio", "isApproved"],
          where: tradesmanWhere,
          required: true,
        },
      ],
      limit,
      offset,
      order: [["createdAt", "DESC"]],
    });

    if (!result || result.count === 0) {
      return sendResponse(res, 404, false, "No tradesmen found");
    }

    const ratingMap = await getRatingSummaryMap(result.rows.map((row) => row.id));

    const formattedRows = result.rows.map((user) =>
      toPublicUserProfile(user.toJSON(), ratingMap[user.id])
    );

    return res.status(200).json({
      success: true,
      message: "Tradesmen fetched",
      data: formattedRows,
      pagination: {
        total: result.count,
        page,
        limit,
        totalPages: Math.ceil(result.count / limit),
      },
    });
  } catch (error) {
    console.error("Fetch Tradesmen Error:", error);
    return sendResponse(res, 500, false, "Server error");
  }
};

/**
 * GET /api/users/clients   (requires login)
 * Lists clients (role = client): id, name, role, profileImage only.
 * Supports pagination ?page & ?limit
 */
exports.getAllClients = async (req, res) => {
  try {
    const { page, limit, offset } = parsePagination(req);
    const { search } = req.query;

    const where = { role: "client" };

    if (search) {
      where.name = { [Op.like]: `%${search}%` };
    }

    const result = await User.findAndCountAll({
      where,
      attributes: ["id", "name", "role", "profileImage"],
      limit,
      offset,
      order: [["createdAt", "DESC"]],
    });

    if (!result || result.count === 0) {
      return sendResponse(res, 404, false, "No clients found");
    }

    result.rows = result.rows.map((row) => toPublicUserProfile(row.toJSON()));

    return paginatedResponse(res, "Clients fetched", result, page, limit);
  } catch (error) {
    console.error("Fetch Clients Error:", error);
    return sendResponse(res, 500, false, "Server error");
  }
};

/**
 * GET /api/users/:id
 * Public profile shape only (see toPublicUserProfile).
 */
exports.getUserById = async (req, res) => {
  try {
    const user = await User.findOne({
      where: { id: req.params.id },
      attributes: ["id", "name", "role", "profileImage"],
      include: [
        {
          model: TradesmanDetails,
          as: "TradesmanDetail",
          attributes: ["tradeTypeId", "tradeType", "businessName", "shortBio", "isApproved"],
        },
      ],
    });

    if (!user) return sendResponse(res, 404, false, "User not found");

    const ratingMap =
      user.role === "tradesman" ? await getRatingSummaryMap([user.id]) : {};

    return sendResponse(
      res,
      200,
      true,
      "User fetched",
      toPublicUserProfile(user.toJSON(), ratingMap[user.id])
    );
  } catch (error) {
    console.error("Fetch User Error:", error);
    return sendResponse(res, 500, false, "Server error");
  }
};

exports.updateProfile = async (req, res) => {
  try {
    const userId = req.user.id; // 🔥 TOKEN SE ID

    const user = await User.findByPk(userId);
    if (!user) return sendResponse(res, 404, false, "User not found");

    const {
      name,
      email,
      mobile,
      password,
      tradeType,
      tradeTypeId,
      businessName,
      shortBio,
      licenseNumber,
      licenseExpiry,
    } = req.body;

    // -------- USERS TABLE (OPTIONAL FIELDS) --------
    if (name !== undefined) user.name = name;
    if (email !== undefined) user.email = email;
    if (mobile !== undefined) user.mobile = mobile;

    if (password) {
      user.password = await bcrypt.hash(password, 10);
    }

    // 🖼 PROFILE IMAGE (OPTIONAL)
    if (req.file) {
      const previousProfileImage = user.profileImage;
      user.profileImage = await storageService.saveSingleImage({
        file: req.file,
        category: "profile",
      });

      if (previousProfileImage && previousProfileImage !== user.profileImage) {
        await storageService.deleteObject(previousProfileImage, {
          category: "profile",
        });
      }
    }

    await user.save();

    // -------- TRADESMAN DETAILS (IF EXISTS) --------
    const tradesman = await TradesmanDetails.findOne({
      where: { userId },
    });

    if (tradesman) {
      if (tradeTypeId !== undefined) {
        const tradeRecord = await TradesType.findOne({
          where: { id: Number(tradeTypeId), isActive: true },
        });

        if (!tradeRecord) {
          return sendResponse(res, 400, false, "Invalid tradeTypeId");
        }

        tradesman.tradeTypeId = Number(tradeTypeId);
        tradesman.tradeType = tradeRecord.name;
      } else if (tradeType !== undefined) {
        tradesman.tradeType = tradeType;
      }
      if (businessName !== undefined) tradesman.businessName = businessName;
      if (shortBio !== undefined) tradesman.shortBio = shortBio;
      if (licenseNumber !== undefined) tradesman.licenseNumber = licenseNumber;
      if (licenseExpiry !== undefined) tradesman.licenseExpiry = licenseExpiry;

      await tradesman.save();
    }

    return sendResponse(res, 200, true, "Profile updated successfully", {
      id: user.id,
      name: user.name,
      email: user.email,
      mobile: user.mobile,
      profileImage: toPublicProfileImage(user.profileImage),
      tradesman: tradesman
        ? {
            tradeTypeId: tradesman.tradeTypeId,
            tradeType: tradesman.tradeType,
            businessName: tradesman.businessName,
            shortBio: tradesman.shortBio,
            licenseNumber: tradesman.licenseNumber,
            licenseExpiry: tradesman.licenseExpiry,
            isApproved: tradesman.isApproved,
          }
        : null,
    });
  } catch (error) {
    console.error("Update Profile Error:", error);
    return sendResponse(res, 500, false, "Server error");
  }
};

exports.deleteUser = async (req, res) => {
  try {
    const requestedUserId = Number(req.params.id);
    const authenticatedUserId = Number(req.user?.id);
    const isAdmin = req.user?.role === "admin";

    if (!isAdmin && authenticatedUserId !== requestedUserId) {
      return sendResponse(res, 403, false, "You can only delete your own account");
    }

    const user = await User.findByPk(req.params.id);

    if (!user) return sendResponse(res, 404, false, "User not found");

    await user.destroy();
    return sendResponse(res, 200, true, "User deleted successfully");
  } catch (error) {
    console.error("Delete Error:", error);
    return sendResponse(res, 500, false, "Server error");
  }
};

exports.forgotPassword = async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);

    if (!email) return sendResponse(res, 400, false, "Email is required");

    const genericMessage =
      "If an account exists for this email, a password reset code has been sent";

    const user = await User.findOne({ where: { email } });
    if (!user) return sendResponse(res, 200, true, genericMessage);

    const otp = generatePasswordResetOtp();
    const expiry = new Date(Date.now() + PASSWORD_RESET_OTP_TTL_MS);

    await user.update({
      resetPasswordToken: `${PASSWORD_RESET_OTP_PREFIX}${hashPasswordResetSecret(otp)}`,
      resetPasswordExpires: expiry,
    });

    const emailContent = buildPasswordResetOtpEmail({
      name: user.name,
      otp,
    });

    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: user.email,
      subject: emailContent.subject,
      text: emailContent.text,
      html: emailContent.html,
    });

    return sendResponse(res, 200, true, genericMessage);
  } catch (err) {
    console.error("Forgot Error:", err);
    return sendResponse(res, 500, false, "Server error");
  }
};

exports.verifyResetOtp = async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const otp = String(req.body.otp || "").trim();

    if (!email) return sendResponse(res, 400, false, "Email is required");
    if (!/^\d{6}$/.test(otp)) {
      return sendResponse(res, 400, false, "OTP must be a 6 digit code");
    }

    const user = await User.findOne({
      where: {
        email,
        resetPasswordToken: `${PASSWORD_RESET_OTP_PREFIX}${hashPasswordResetSecret(otp)}`,
        resetPasswordExpires: { [Op.gt]: new Date() },
      },
    });

    if (!user) return sendResponse(res, 400, false, "Invalid or expired OTP");

    const resetToken = crypto.randomBytes(32).toString("hex");

    await user.update({
      resetPasswordToken: `${PASSWORD_RESET_TOKEN_PREFIX}${resetToken}`,
      resetPasswordExpires: new Date(Date.now() + PASSWORD_RESET_TOKEN_TTL_MS),
    });

    return sendResponse(res, 200, true, "OTP verified", {
      resetToken,
      expiresInMinutes: Math.floor(PASSWORD_RESET_TOKEN_TTL_MS / 60 / 1000),
    });
  } catch (error) {
    console.error("Verify Reset OTP Error:", error);
    return sendResponse(res, 500, false, "Server error");
  }
};

exports.resetPassword = async (req, res) => {
  try {
    const { token } = req.params;
    const { newPassword } = req.body;

    if (!token) return sendResponse(res, 400, false, "Reset token is required");
    if (!newPassword || String(newPassword).length < 8) {
      return sendResponse(
        res,
        400,
        false,
        "New password must be at least 8 characters"
      );
    }

    const user = await User.findOne({
      where: {
        resetPasswordToken: {
          [Op.in]: [token, `${PASSWORD_RESET_TOKEN_PREFIX}${token}`],
        },
        resetPasswordExpires: { [Op.gt]: new Date() },
      },
    });

    if (!user) return sendResponse(res, 400, false, "Invalid or expired token");

    const hashed = await bcrypt.hash(newPassword, 10);

    await user.update({
      password: hashed,
      resetPasswordToken: null,
      resetPasswordExpires: null,
    });

    return sendResponse(res, 200, true, "Password reset successful");
  } catch (error) {
    console.error("Reset Error:", error);
    return sendResponse(res, 500, false, "Server error");
  }
};

exports.changePassword = async (req, res) => {
  try {
    const userId = req.user?.id;
    const { oldPassword, newPassword, confirmNewPassword } = req.body;

    if (!oldPassword || !newPassword || !confirmNewPassword)
      return sendResponse(res, 400, false, "All fields required");

    if (newPassword !== confirmNewPassword)
      return sendResponse(res, 400, false, "New password mismatch");

    const user = await User.findByPk(userId);

    const isMatch = await bcrypt.compare(oldPassword, user.password);
    if (!isMatch)
      return sendResponse(res, 400, false, "Old password incorrect");

    user.password = await bcrypt.hash(newPassword, 10);
    await user.save();

    return sendResponse(res, 200, true, "Password changed successfully");
  } catch (error) {
    console.error("Change Password Error:", error);
    return sendResponse(res, 500, false, "Server error");
  }
};

exports.getMeProfile = async (req, res) => {
  try {
    const user = await User.findOne({
      where: { id: req.user.id },
      include: [{ model: TradesmanDetails, as: "TradesmanDetail" }],
    });

    if (!user) {
      return sendResponse(res, 404, false, "User not found");
    }

    const userJson = user.toJSON();
    const reviewSummary = await getUserReceivedReviewSummary(req.user.id);

    return sendResponse(
      res,
      200,
      true,
      "User fetched",
      serializeUserWithTradesman({
        ...userJson,
        tradeTypeId: userJson.TradesmanDetail?.tradeTypeId || null,
        tradeType: userJson.TradesmanDetail?.tradeType || null,
        ...reviewSummary,
      })
    );
  } catch (error) {
    console.error(error);
    return sendResponse(res, 500, false, "Server error");
  }
};

exports.getClientProfileForTradesman = async (req, res) => {
  try {
    const tradesmanId = req.user?.id;
    const requesterRole = req.user?.role;
    const clientId = Number(req.params.clientId);

    if (requesterRole !== "tradesman") {
      return sendResponse(
        res,
        403,
        false,
        "Only tradesmen can access client profiles from this endpoint"
      );
    }

    if (!clientId || Number.isNaN(clientId)) {
      return sendResponse(res, 400, false, "Valid clientId is required");
    }

    const client = await User.findOne({
      where: { id: clientId, role: "client" },
      attributes: ["id", "name", "email", "mobile", "profileImage", "role", "createdAt"],
    });

    if (!client) {
      return sendResponse(res, 404, false, "Client not found");
    }

    const hireConnection = await Hire.findOne({
      where: { clientId, tradesmanId },
      attributes: ["id", "status", "createdAt", "updatedAt"],
      order: [["updatedAt", "DESC"]],
    });

    const messageConnection = await Message.findOne({
      where: {
        [Op.or]: [
          { senderId: clientId, receiverId: tradesmanId },
          { senderId: tradesmanId, receiverId: clientId },
        ],
      },
      attributes: ["id", "senderId", "receiverId", "createdAt"],
      order: [["createdAt", "DESC"]],
    });

    if (!hireConnection && !messageConnection) {
      return sendResponse(
        res,
        403,
        false,
        "You can view this client profile only after a hire request or chat exists"
      );
    }

    const reviewSummary = await getUserReceivedReviewSummary(clientId);

    const completedJobsCount = await Hire.count({
      where: { clientId, status: "completed" },
    });

    return sendResponse(res, 200, true, "Client profile fetched successfully", {
      id: client.id,
      name: client.name,
      email: client.email,
      mobile: client.mobile,
      role: client.role,
      profileImage: toPublicProfileImage(client.profileImage),
      rating: reviewSummary.rating,
      reviewCount: reviewSummary.reviewCount,
      reviews: reviewSummary.reviews,
      completedJobsCount,
      access: {
        hasHireConnection: Boolean(hireConnection),
        hasChatConnection: Boolean(messageConnection),
        latestHire: hireConnection
          ? {
              id: hireConnection.id,
              status: hireConnection.status,
              createdAt: hireConnection.createdAt,
              updatedAt: hireConnection.updatedAt,
            }
          : null,
        latestMessageAt: messageConnection?.createdAt || null,
      },
    });
  } catch (error) {
    console.error("Client Profile Access Error:", error);
    return sendResponse(res, 500, false, "Server error", null, error.message);
  }
};

exports.getFullUserProfile = async (req, res) => {
  try {
    const userId = req.params.id;

    /* ================= USER + DETAILS + ACTIVE TRAVEL PLAN ================= */
    const user = await User.findByPk(userId, {
      attributes: ["id", "name", "profileImage", "role"],
      include: [
        {
          model: TradesmanDetails,
          as: "TradesmanDetail",
          attributes: ["tradeTypeId", "tradeType", "businessName", "shortBio"],
        },
        {
          model: TravelPlan,
          as: "travelPlans", // ✅ FIXED ALIAS
          where: {
            status: { [Op.in]: ACTIVE_TRAVEL_PLAN_STATUSES },
            destinationDateTime: { [Op.gte]: new Date() },
          },
          required: false,
        },
      ],
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    /* ================= JOB HISTORY ================= */
    let jobHistory = [];

    if (user.role === "tradesman") {
      const jobs = await Hire.findAll({
        where: { tradesmanId: userId },
        include: [
          {
            model: User,
            as: "client",
            attributes: ["id", "name"],
          },
        ],
        order: [["updatedAt", "DESC"]],
      });

      jobHistory = jobs.map((j) => ({
        jobId: j.id,
        customerName: j.client?.name || null,
        jobTitle: j.jobTitle || "Service Work",
        address: j.address || null,
        status: j.status,
        date: j.updatedAt,
      }));
    }

    /* ================= REVIEWS ================= */
    const reviewSummary = await getUserReceivedReviewSummary(userId);

    /* ================= ACTIVE TRAVEL PLAN ================= */
    const activePlan = user.travelPlans?.[0] || null;

    /* ================= FINAL RESPONSE (UI READY) ================= */
    return res.json({
      success: true,
      message: "Profile fetched successfully",
      data: {
        /* PROFILE HEADER */
        id: user.id,
        name: user.name,
        profileImage: toPublicProfileImage(user.profileImage),
        tradeTypeId: user.TradesmanDetail?.tradeTypeId || null,
        tradeType: user.TradesmanDetail?.tradeType || null,
        description: user.TradesmanDetail?.shortBio || null,

        /* RATING */
        rating: reviewSummary.rating,
        reviewCount: reviewSummary.reviewCount,
        reviews: reviewSummary.reviews,

        /* AVAILABILITY */
        availability: activePlan ? "Available" : "Not Available",

        /* LOCATION / TRAVEL */
        travelPlan: activePlan
          ? {
              currentLocation: activePlan.currentLocation,
              startLocation: activePlan.startLocation,
              destination: activePlan.destination,
              priceRange: activePlan.priceRange,
              startDate: activePlan.startDate,
              endDate: activePlan.endDate,
            }
          : null,

        /* JOB HISTORY (UI LIST) */
        jobHistory,
      },
    });
  } catch (error) {
    console.error("Profile Error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
};

// exports.filterTradesmen = async (req, res) => {
//   try {
//     console.log("🔥 NEW FILTER CONTROLLER HIT 🔥");
//     console.log("🔍 Incoming filter query:", req.query);

//     const {
//       tradeTypeId,
//       tradeType,
//       lat,
//       lng,
//       radius = 40,
//       rating,
//       verified,
//       availability,
//     } = req.query;

//     /* ================= BASIC SETUP ================= */

//     const userLat = lat ? Number(lat) : null;
//     const userLng = lng ? Number(lng) : null;
//     const maxRadius = Number(radius);

//     let whereUser = { role: "tradesman" };
//     let whereTrade = {};

//     /* ================= 1️⃣ TRADE TYPE FILTER ================= */

//     if (
//       tradeTypeId !== undefined &&
//       tradeTypeId !== null &&
//       tradeTypeId !== ""
//     ) {
//       if (Number.isNaN(Number(tradeTypeId))) {
//         return sendResponse(
//           res,
//           400,
//           false,
//           "tradeTypeId must be a valid number",
//         );
//       }
//       tradesmanWhere.tradeTypeId = Number(tradeTypeId);
//     } else if (tradeType) {
//       tradesmanWhere.tradeType = tradeType;
//     }

//     /* ================= 2️⃣ VERIFIED FILTER ================= */

//     if (verified === "true") {
//       whereTrade.isApproved = true;
//       console.log("✅ Verified tradesmen only");
//     }

//     /* ================= 3️⃣ AVAILABILITY FILTER ================= */

//     if (availability === "today") {
//       const now = new Date();
//       whereTrade.startDate = { [Op.lte]: now };
//       whereTrade.endDate = { [Op.gte]: now };
//       console.log("✅ Availability: today");
//     }

//     /* ================= 4️⃣ FETCH TRADESMEN ================= */

//     let tradesmen = await User.findAll({
//       where: whereUser,
//       include: [
//         {
//           model: TradesmanDetails,
//           as: "tradesmanDetails",
//           where: tradesmanWhere,
//           required: true,
//         },
//       ],
//     });

//     console.log(`📦 Tradesmen fetched from DB: ${tradesmen.length}`);

//     if (!tradesmen.length) {
//       return res.json({
//         success: true,
//         message: "No tradesmen found",
//         data: [],
//       });
//     }

//     /* ================= 5️⃣ RATING FILTER (NO N+1) ================= */

//     if (rating) {
//       console.log(`⭐ Applying rating filter >= ${rating}`);

//       const ratings = await Review.findAll({
//         attributes: ["toUserId", [fn("AVG", col("rating")), "avgRating"]],
//         where: {
//           toUserId: tradesmen.map((t) => t.id),
//         },
//         group: ["toUserId"],
//         raw: true,
//       });

//       const ratingMap = Object.fromEntries(
//         ratings.map((r) => [r.toUserId, Number(r.avgRating)]),
//       );

//       tradesmen = tradesmen.filter((t) => {
//         const avg = ratingMap[t.id] || 0;
//         t.dataValues.avgRating = avg;
//         return avg >= Number(rating);
//       });

//       console.log(`⭐ After rating filter: ${tradesmen.length}`);
//     }

//     /* ================= 6️⃣ GPS DISTANCE FILTER ================= */

//     if (userLat !== null && userLng !== null) {
//       console.log("📍 Applying GPS filter", {
//         userLat,
//         userLng,
//         maxRadius,
//       });

//       const R = 6371; // Earth radius in km

//       tradesmen = tradesmen.filter((t) => {
//         const location = t.TradesmanDetail.currentLocation;
//         if (!location) return false;

//         const [tLat, tLng] = location.split(",").map(Number);
//         if (!tLat || !tLng) return false;

//         const dLat = ((tLat - userLat) * Math.PI) / 180;
//         const dLng = ((tLng - userLng) * Math.PI) / 180;

//         const a =
//           Math.sin(dLat / 2) ** 2 +
//           Math.cos((userLat * Math.PI) / 180) *
//             Math.cos((tLat * Math.PI) / 180) *
//             Math.sin(dLng / 2) ** 2;

//         const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
//         const distance = R * c;

//         t.dataValues.distance = Number(distance.toFixed(2));

//         return distance <= maxRadius;
//       });

//       console.log(`📍 After GPS filter: ${tradesmen.length}`);
//     }

//     /* ================= FINAL RESPONSE ================= */

//     return res.json({
//       success: true,
//       message: "Filtered tradesmen",
//       count: tradesmen.length,
//       data: tradesmen,
//     });
//   } catch (err) {
//     console.error("❌ Filter Error:", err);
//     return res.status(500).json({
//       success: false,
//       message: "Server error",
//     });
//   }
// };

const NO_AVAILABILITY = {
  availability: "unavailable",
  hasActivePlan: false,
  location: null,
};

/**
 * Availability and a basic location summary for many tradesmen with ONE query.
 *
 * Derived from the travel-plan times (not the persisted status, which can lag):
 * - "available_now": a plan is running right now
 * - "upcoming": no running plan, but one starts later
 * - "unavailable": no current or upcoming plan
 *
 * @param {number[]} tradesmanIds
 * @param {Date} [now]
 * @returns {Promise<Record<number, {availability: string, hasActivePlan: boolean, location: object|null}>>}
 */
const getAvailabilityByTradesman = async (tradesmanIds, now = new Date()) => {
  const ids = [...new Set((tradesmanIds || []).map(Number).filter(Boolean))];
  if (!ids.length) return {};

  const plans = await TravelPlan.findAll({
    where: {
      tradesmanId: { [Op.in]: ids },
      status: { [Op.in]: ACTIVE_TRAVEL_PLAN_STATUSES },
      destinationDateTime: { [Op.gte]: now },
    },
    attributes: [
      "id",
      "tradesmanId",
      "currentLocation",
      "latitude",
      "longitude",
      "destination",
      "destinationLatitude",
      "destinationLongitude",
      "startDateTime",
      "destinationDateTime",
    ],
    order: [["startDateTime", "ASC"]],
  });

  const result = {};

  for (const plan of plans) {
    const tradesmanId = Number(plan.tradesmanId);
    const running =
      new Date(plan.startDateTime) <= now && new Date(plan.destinationDateTime) >= now;

    // Plans are sorted by start time: keep a running plan, otherwise the soonest upcoming one.
    if (result[tradesmanId] && (result[tradesmanId].availability === "available_now" || !running)) {
      continue;
    }

    result[tradesmanId] = {
      availability: running ? "available_now" : "upcoming",
      hasActivePlan: true,
      location: {
        travelPlanId: plan.id,
        current: plan.currentLocation,
        latitude: plan.latitude,
        longitude: plan.longitude,
        destination: plan.destination,
        destinationLatitude: plan.destinationLatitude,
        destinationLongitude: plan.destinationLongitude,
        startDateTime: plan.startDateTime,
        destinationDateTime: plan.destinationDateTime,
      },
    };
  }

  return result;
};

exports.filterTradesmen = async (req, res) => {
  try {
    // Request data (query/body, coordinates) is deliberately not logged.
    const input = parseFilterInput(req);
    const {
      tradeTypeId,
      tradeTypeIds,
      latitude,
      longitude,
      lat,
      lng,
      startDate,
      endDate,
      rating,
      radiusKm,
    } = input;

    const requestedLatitude =
      latitude !== undefined && latitude !== null && latitude !== ""
        ? Number(latitude)
        : lat !== undefined && lat !== null && lat !== ""
          ? Number(lat)
          : null;

    const requestedLongitude =
      longitude !== undefined && longitude !== null && longitude !== ""
        ? Number(longitude)
        : lng !== undefined && lng !== null && lng !== ""
          ? Number(lng)
          : null;

    if (
      (requestedLatitude !== null && Number.isNaN(requestedLatitude)) ||
      (requestedLongitude !== null && Number.isNaN(requestedLongitude))
    ) {
      return sendResponse(
        res,
        400,
        false,
        "latitude and longitude must be valid numbers",
      );
    }

    if ((requestedLatitude === null) !== (requestedLongitude === null)) {
      return sendResponse(
        res,
        400,
        false,
        "latitude and longitude must be provided together",
      );
    }

    const normalizedStartDate = normalizeDateOrNull(startDate);
    const normalizedEndDate = normalizeDateOrNull(endDate);

    if ((startDate && !normalizedStartDate) || (endDate && !normalizedEndDate)) {
      return sendResponse(res, 400, false, "startDate or endDate is invalid");
    }

    if (!!startDate !== !!endDate) {
      return sendResponse(
        res,
        400,
        false,
        "startDate and endDate must be provided together",
      );
    }

    if (
      normalizedStartDate &&
      normalizedEndDate &&
      normalizedStartDate.getTime() > normalizedEndDate.getTime()
    ) {
      return sendResponse(
        res,
        400,
        false,
        "startDate cannot be greater than endDate",
      );
    }

    const minimumRating =
      rating !== undefined && rating !== null && rating !== ""
        ? Number(rating)
        : null;

    if (
      minimumRating !== null &&
      (Number.isNaN(minimumRating) || minimumRating < 0 || minimumRating > 5)
    ) {
      return sendResponse(
        res,
        400,
        false,
        "rating must be a valid number between 0 and 5",
      );
    }

    // Optional search radius from the app; capped so a client cannot ask for "everywhere".
    let effectiveRadiusKm = DEFAULT_FILTER_RADIUS_KM;
    if (radiusKm !== undefined && radiusKm !== null && radiusKm !== "") {
      const requestedRadius = Number(radiusKm);

      if (!Number.isFinite(requestedRadius) || requestedRadius <= 0) {
        return sendResponse(
          res,
          400,
          false,
          "radiusKm must be a number greater than 0",
        );
      }

      effectiveRadiusKm = Math.min(requestedRadius, MAX_FILTER_RADIUS_KM);
    }

    // Optional pagination. Without `limit` every match is returned, as before.
    let pageNumber = 1;
    let pageLimit = null;

    if (input.limit !== undefined && input.limit !== null && input.limit !== "") {
      const requestedLimit = Number(input.limit);

      if (!Number.isInteger(requestedLimit) || requestedLimit < 1) {
        return sendResponse(
          res,
          400,
          false,
          `limit must be a whole number between 1 and ${MAX_FILTER_PAGE_SIZE}`,
        );
      }

      pageLimit = Math.min(requestedLimit, MAX_FILTER_PAGE_SIZE);
    }

    if (input.page !== undefined && input.page !== null && input.page !== "") {
      const requestedPage = Number(input.page);

      if (!Number.isInteger(requestedPage) || requestedPage < 1) {
        return sendResponse(
          res,
          400,
          false,
          "page must be a whole number greater than 0",
        );
      }

      pageNumber = requestedPage;
    }

    let normalizedTradeTypeIds = normalizeTradeTypeIds(tradeTypeIds);
    if (normalizedTradeTypeIds === null) {
      return sendResponse(
        res,
        400,
        false,
        "tradeTypeIds must contain only valid numbers",
      );
    }

    if (
      tradeTypeId !== undefined &&
      tradeTypeId !== null &&
      tradeTypeId !== ""
    ) {
      const singleTradeTypeId = Number(tradeTypeId);
      if (Number.isNaN(singleTradeTypeId)) {
        return sendResponse(
          res,
          400,
          false,
          "tradeTypeId must be a valid number",
        );
      }

      normalizedTradeTypeIds = [
        ...new Set([singleTradeTypeId, ...normalizedTradeTypeIds]),
      ];
    }

    const shouldApplyStopFilter =
      requestedLatitude !== null ||
      (normalizedStartDate !== null && normalizedEndDate !== null);

    const tradesmanWhere = {
      isApproved: true,
    };

    if (normalizedTradeTypeIds.length === 1) {
      tradesmanWhere.tradeTypeId = normalizedTradeTypeIds[0];
    } else if (normalizedTradeTypeIds.length > 1) {
      tradesmanWhere.tradeTypeId = { [Op.in]: normalizedTradeTypeIds };
    }

    const include = [
      {
        model: TradesmanDetails,
        as: "TradesmanDetail",
        where: tradesmanWhere,
        required: true,
      },
    ];

    if (shouldApplyStopFilter) {
      include.push({
        model: TravelPlan,
        as: "travelPlans",
        where: {
          status: { [Op.in]: ACTIVE_TRAVEL_PLAN_STATUSES },
          destinationDateTime: { [Op.gte]: new Date() },
        },
        required: true,
      });
    }

    const tradesmen = await User.findAll({
      where: { role: "tradesman" },
      include,
      order: [["createdAt", "DESC"]],
    });

    console.log(`📦 Tradesmen fetched from DB: ${tradesmen.length}`);

    if (!tradesmen.length) {
      return sendResponse(res, 200, true, "Filtered tradesmen", {
        radiusKm: effectiveRadiusKm,
        appliedFilters: {
          tradeTypeIds: normalizedTradeTypeIds,
          latitude: requestedLatitude,
          longitude: requestedLongitude,
          startDate: normalizedStartDate,
          endDate: normalizedEndDate,
          rating: minimumRating,
        },
        count: 0,
        total: 0,
        ...(pageLimit === null
          ? {}
          : {
              pagination: {
                total: 0,
                page: pageNumber,
                limit: pageLimit,
                totalPages: 1,
                hasMore: false,
              },
            }),
        data: [],
      });
    }

    const ratingRows = await Review.findAll({
      attributes: [
        "toUserId",
        [fn("AVG", col("rating")), "avgRating"],
        [fn("COUNT", col("id")), "reviewCount"],
      ],
      where: {
        toUserId: tradesmen.map((tradesman) => tradesman.id),
      },
      group: ["toUserId"],
      raw: true,
    });

    const ratingMap = Object.fromEntries(
      ratingRows.map((item) => [
        Number(item.toUserId),
        {
          avgRating: Number(Number(item.avgRating || 0).toFixed(1)),
          reviewCount: Number(item.reviewCount || 0),
        },
      ]),
    );

    const filteredTradesmen = tradesmen
      .map((tradesman) => {
        const json = tradesman.toJSON();
        const reviewSummary = ratingMap[tradesman.id] || {
          avgRating: 0,
          reviewCount: 0,
        };

        if (
          minimumRating !== null &&
          Number(reviewSummary.avgRating) < minimumRating
        ) {
          return null;
        }

        let bestMatchedStop = null;

        if (shouldApplyStopFilter) {
          const travelPlans = Array.isArray(json.travelPlans) ? json.travelPlans : [];

          for (const travelPlan of travelPlans) {
            const stopPoints = getRoutePointsFromTravelPlan(travelPlan);

            // Also the road between consecutive points, so a client on the way
            // between two stops still finds the tradesman.
            if (requestedLatitude !== null && requestedLongitude !== null) {
              stopPoints.push(
                ...getLegCandidates(
                  getOrderedRoutePointsFromTravelPlan(travelPlan),
                  requestedLatitude,
                  requestedLongitude,
                ),
              );
            }

            for (const stop of stopPoints) {
              if (
                !isStopWithinDateRange(
                  stop,
                  normalizedStartDate,
                  normalizedEndDate,
                )
              ) {
                continue;
              }

              let distanceKm = null;

              if (requestedLatitude !== null && requestedLongitude !== null) {
                distanceKm = Number(
                  getDistanceKm(
                    requestedLatitude,
                    requestedLongitude,
                    stop.latitude,
                    stop.longitude,
                  ).toFixed(2),
                );

                if (distanceKm > effectiveRadiusKm) {
                  continue;
                }
              }

              if (
                !bestMatchedStop ||
                (distanceKm !== null &&
                  (bestMatchedStop.distanceKm === null ||
                    distanceKm < bestMatchedStop.distanceKm)) ||
                (distanceKm === null &&
                  !bestMatchedStop.expectedDateTime &&
                  stop.expectedDateTime)
              ) {
                bestMatchedStop = {
                  ...stop,
                  distanceKm,
                  travelPlanId: travelPlan.id,
                };
              }
            }
          }

          if (!bestMatchedStop) {
            return null;
          }
        }

        // Public profile only: never the raw user row (no email, mobile,
        // password hash, licence or approval fields).
        return {
          ...toPublicUserProfile(json, reviewSummary),
          matchedStop: bestMatchedStop
            ? {
                name: bestMatchedStop.name,
                latitude: bestMatchedStop.latitude,
                longitude: bestMatchedStop.longitude,
                expectedDateTime: bestMatchedStop.expectedDateTime,
              }
            : null,
          matchedDistanceKm: bestMatchedStop?.distanceKm ?? null,
          matchedTravelPlanId: bestMatchedStop?.travelPlanId ?? null,
        };
      })
      .filter(Boolean);

    // Nearest first for a location search (newest first otherwise), so pages
    // are in a stable, useful order.
    if (requestedLatitude !== null && requestedLongitude !== null) {
      filteredTradesmen.sort(
        (a, b) =>
          (a.matchedDistanceKm ?? Infinity) - (b.matchedDistanceKm ?? Infinity),
      );
    }

    const total = filteredTradesmen.length;
    const pageItems =
      pageLimit === null
        ? filteredTradesmen
        : filteredTradesmen.slice(
            (pageNumber - 1) * pageLimit,
            pageNumber * pageLimit,
          );

    // Availability + a basic location summary for the returned page only, so
    // the app needs no per-tradesman request.
    const availabilityMap = await getAvailabilityByTradesman(
      pageItems.map((tradesman) => tradesman.id)
    );

    const responseData = pageItems.map((tradesman) => ({
      ...tradesman,
      ...(availabilityMap[tradesman.id] || NO_AVAILABILITY),
    }));

    return sendResponse(res, 200, true, "Filtered tradesmen", {
      radiusKm: effectiveRadiusKm,
      appliedFilters: {
        tradeTypeIds: normalizedTradeTypeIds,
        latitude: requestedLatitude,
        longitude: requestedLongitude,
        startDate: normalizedStartDate,
        endDate: normalizedEndDate,
        rating: minimumRating,
      },
      count: responseData.length,
      total,
      ...(pageLimit === null
        ? {}
        : {
            pagination: {
              total,
              page: pageNumber,
              limit: pageLimit,
              totalPages: Math.max(1, Math.ceil(total / pageLimit)),
              hasMore: pageNumber * pageLimit < total,
            },
          }),
      data: responseData,
    });
  } catch (err) {
    console.error("❌ Filter Error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
};

exports.updateTradesmanProfile = async (req, res) => {
  try {
    const userId = req.user.id; // 🔐 token se user id

    /* ================= FIND USER ================= */
    const user = await User.findByPk(userId);
    if (!user) {
      return sendResponse(res, 404, false, "User not found");
    }

    /* ================= FIND TRADESMAN ================= */
    const tradesman = await TradesmanDetails.findOne({
      where: { userId },
    });

    if (!tradesman) {
      return sendResponse(res, 404, false, "Tradesman details not found");
    }

    /* ================= BODY DATA ================= */
    const {
      name,
      mobile,
      tradeType,
      tradeTypeId,
      businessName,
      shortBio,
      licenseNumber,
      licenseExpiry,
      portfolioDescription,
    } = req.body;

    /* ================= FILES ================= */
    const profileImageFile = req.files?.profileImage?.[0] || null;
    const portfolioFiles = req.files?.portfolioPhotos || [];

    /* ================= UPDATE USER ================= */
    if (name !== undefined) user.name = name;
    if (mobile !== undefined) user.mobile = mobile;

    if (profileImageFile) {
      const previousProfileImage = user.profileImage;
      user.profileImage = await storageService.saveSingleImage({
        file: profileImageFile,
        category: "profile",
      });

      if (previousProfileImage && previousProfileImage !== user.profileImage) {
        await storageService.deleteObject(previousProfileImage, {
          category: "profile",
        });
      }
    }

    await user.save();

    /* ================= UPDATE TRADESMAN DETAILS ================= */
    if (tradeTypeId !== undefined) {
      const tradeRecord = await TradesType.findOne({
        where: { id: Number(tradeTypeId), isActive: true },
      });

      if (!tradeRecord) {
        return sendResponse(res, 400, false, "Invalid tradeTypeId");
      }

      tradesman.tradeTypeId = Number(tradeTypeId);
      tradesman.tradeType = tradeRecord.name;
    } else if (tradeType !== undefined) {
      tradesman.tradeType = tradeType;
    }
    if (businessName !== undefined) tradesman.businessName = businessName;
    if (shortBio !== undefined) tradesman.shortBio = shortBio;
    if (licenseNumber !== undefined) tradesman.licenseNumber = licenseNumber;
    if (licenseExpiry !== undefined) tradesman.licenseExpiry = licenseExpiry;
    if (portfolioDescription !== undefined) {
      tradesman.portfolioDescription = portfolioDescription;
    }

    // ❌ licenseDocument update NOT allowed

    if (portfolioFiles.length > 0) {
      const previousPortfolioPhotos = Array.isArray(tradesman.portfolioPhotos)
        ? [...tradesman.portfolioPhotos]
        : [];

      tradesman.portfolioPhotos = await storageService.saveMultipleImages({
        files: portfolioFiles,
        category: "portfolio",
      });

      await storageService.deleteObjects(previousPortfolioPhotos, {
        category: "portfolio",
      });
    }

    await tradesman.save();

    /* ================= FINAL RESPONSE ================= */
    return sendResponse(res, 200, true, "Profile updated successfully", {
      user: {
        id: user.id,
        name: user.name,
        mobile: user.mobile,
        profileImage: toPublicProfileImage(user.profileImage),
      },
      tradesman: {
        tradeTypeId: tradesman.tradeTypeId,
        tradeType: tradesman.tradeType,
        businessName: tradesman.businessName,
        shortBio: tradesman.shortBio,
        portfolioDescription: tradesman.portfolioDescription,
        licenseNumber: tradesman.licenseNumber,
        licenseExpiry: tradesman.licenseExpiry,
        portfolioPhotos: toPublicPortfolioPhotos(tradesman.portfolioPhotos || []),
      },
    });
  } catch (error) {
    console.error("Update Tradesman Profile Error:", error);
    return sendResponse(res, 500, false, "Server error");
  }
};

exports.filterNearbyTradesmen = async (req, res) => {
  try {
    const {
      latitude,
      longitude,
      radius = 40, // km
      tradeTypeId,
      tradeType,
      minRating = 0,
      onlyVerified = true,
      availability = "open",
    } = req.body;

    if (
      latitude === undefined ||
      latitude === null ||
      longitude === undefined ||
      longitude === null
    ) {
      return res.status(400).json({
        success: false,
        message: "Latitude & longitude required",
      });
    }

    if (Number.isNaN(Number(latitude)) || Number.isNaN(Number(longitude))) {
      return res.status(400).json({
        success: false,
        message: "Latitude and longitude must be valid numbers",
      });
    }

    if (
      tradeTypeId !== undefined &&
      tradeTypeId !== null &&
      tradeTypeId !== "" &&
      Number.isNaN(Number(tradeTypeId))
    ) {
      return res.status(400).json({
        success: false,
        message: "tradeTypeId must be a valid number",
      });
    }

    const distanceSQL = `
      (6371 * acos(
        cos(radians(${Number(latitude)})) *
        cos(radians(travelPlans.latitude)) *
        cos(radians(travelPlans.longitude) - radians(${Number(longitude)})) +
        sin(radians(${Number(latitude)})) *
        sin(radians(travelPlans.latitude))
      ))
    `;

    const tradesmanWhere = {
      ...(onlyVerified && { isApproved: true }),
    };

    if (
      tradeTypeId !== undefined &&
      tradeTypeId !== null &&
      tradeTypeId !== ""
    ) {
      tradesmanWhere.tradeTypeId = Number(tradeTypeId);
    } else if (tradeType) {
      tradesmanWhere.tradeType = tradeType;
    }

    const tradesmen = await User.findAll({
      where: { role: "tradesman" },
      attributes: ["id", "name", "profileImage"],

      include: [
        {
          model: TradesmanDetails,
          as: "TradesmanDetail",
          required: true,
          where: tradesmanWhere,
        },
        {
          model: TravelPlan,
          as: "travelPlans",
          required: true,
          where: {
            status: availability,
            latitude: { [Op.ne]: null },
            longitude: { [Op.ne]: null },
          },
          attributes: {
            include: [[literal(distanceSQL), "distance"]],
          },
        },
      ],

      having: literal(`${distanceSQL} <= ${Number(radius)}`),
      order: [[literal(distanceSQL), "ASC"]],
    });

    const result = await Promise.all(
      tradesmen.map(async (t) => {
        const ratingAgg = await Review.findOne({
          where: { toUserId: t.id },
          attributes: [
            [fn("AVG", col("rating")), "avgRating"],
            [fn("COUNT", col("id")), "reviewCount"],
          ],
          raw: true,
        });

        const rating = ratingAgg?.avgRating ? Number(ratingAgg.avgRating) : 0;

        if (rating < Number(minRating)) return null;

        return {
          id: t.id,
          name: t.name,
          profileImage: toPublicProfileImage(t.profileImage),
          tradeTypeId: t.TradesmanDetail?.tradeTypeId || null,
          tradeType: t.TradesmanDetail?.tradeType || null,
          businessName: t.TradesmanDetail?.businessName || null,
          rating: rating.toFixed(1),
          reviewCount: ratingAgg?.reviewCount || 0,
          distance: Number(t.travelPlans[0].get("distance")).toFixed(2),
          availability: "Available",
        };
      }),
    );

    return res.json({
      success: true,
      message: "Filtered tradesmen fetched",
      data: result.filter(Boolean),
    });
  } catch (err) {
    console.error("Filter error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
};
