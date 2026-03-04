const User = require('../models/User');
const TradesmanDetails = require("../models/TradesmanDetails");
const SubscriptionPlan = require("../models/SubscriptionPlan");
const UserSubscription = require("../models/UserSubscription");
const Hire = require("../models/hireModel");
const Review = require("../models/reviewModel");
const TravelPlan = require("../models/locationModel");


const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Op, fn, col, literal } = require("sequelize");
const crypto = require('crypto');
const transporter = require('../config/email');
require('dotenv').config();

const distanceFormula = (lat, lng) => `
  (6371 * acos(
    cos(radians(${lat})) *
    cos(radians(latitude)) *
    cos(radians(longitude) - radians(${lng})) +
    sin(radians(${lat})) *
    sin(radians(latitude))
  ))
`;

const sendResponse = (res, statusCode, success, message, data = null, error = null) => {
  return res.status(statusCode).json({ success, message, data, error });
};

const signToken = (user) => {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
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

exports.register = async (req, res) => {
  try {
    const {
      name,
      email,
      mobile,
      password,
      role,              // "tradesman" | "client"

      // Tradesman-only text fields
      tradeType,
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
      if (!tradeType || !businessName || !shortBio) {
        return sendResponse(res, 400, false, "tradeType, businessName, shortBio required for tradesman");
      }
      if (!licenseNumber || !licenseExpiry) {
        return sendResponse(res, 400, false, "licenseNumber & licenseExpiry required for tradesman");
      }
      if (!profileImageFile) {
        return sendResponse(res, 400, false, "profileImage file is required for tradesman");
      }
      if (!licenseDocFile) {
        return sendResponse(res, 400, false, "licenseDocument file is required for tradesman");
      }
      if (!portfolioFiles.length) {
        return sendResponse(res, 400, false, "At least one portfolioPhotos file is required for tradesman");
      }
    }

    // 3) Password hash
    const hashedPass = await bcrypt.hash(password, 10);

    // 4) User create (profileImage = filename)
    const user = await User.create({
      name,
      email,
      mobile,
      password: hashedPass,
      role,
      profileImage: profileImageFile ? profileImageFile.filename : null,
    });

    // 5) TradesmanDetails create (licenseDocument + portfolioPhotos array)
    if (role === "tradesman") {
      const portfolioPhotos = portfolioFiles.map((f) => f.filename);

      await TradesmanDetails.create({
        userId: user.id,
        tradeType,
        businessName,
        shortBio,
        licenseNumber,
        licenseExpiry,
        licenseDocument: licenseDocFile.filename,
        portfolioPhotos,
        portfolioDescription,
      });

      // 6) Default subscription: Free Trial
      const freePlan = await SubscriptionPlan.findOne({
        where: { isDefault: true },
      });

      if (freePlan) {
        await UserSubscription.create({
          userId: user.id,
          planId: freePlan.id,
          startDate: new Date(),
          status: "active",
        });
      }
    }

    return sendResponse(res, 201, true, "User registered successfully", user);
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
      return res.status(400).json({ success: false, message: 'Invalid email or password' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ success: false, message: 'Invalid email or password' });
    }

    const token = signToken(user);

    return res.status(200).json({
      success: true,
      message: 'Login successful',
      data: {
        token,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
        }
      }
    });

  } catch (error) {
    console.error("Login Error:", error);
    return sendResponse(res, 500, false, "Server error");
  }
};

/**
 * GET /api/users
 * Supports pagination and optional search & role filter:
 * ?page=1&limit=10&search=deepak&role=tradesman
 */
exports.getAllUsers = async (req, res) => {
  try {
    const { page, limit, offset } = parsePagination(req);
    const { search, role } = req.query;

    const where = {};
    if (role) where.role = role;

    if (search) {
      where[Op.or] = [
        { name: { [Op.iLike]: `%${search}%` } }, // For Postgres; with other DBs use Op.substring or adjust as needed
        { email: { [Op.iLike]: `%${search}%` } },
        { mobile: { [Op.iLike]: `%${search}%` } },
      ];
    }

    // use findAndCountAll for pagination metadata
    const result = await User.findAndCountAll({
      where,
      include: [{ model: TradesmanDetails, as: "TradesmanDetail" }],
      limit,
      offset,
      order: [['createdAt', 'DESC']],
    });

    return paginatedResponse(res, "Users fetched", result, page, limit);
  } catch (error) {
    console.error("Fetch Users Error:", error);
    return sendResponse(res, 500, false, "Server error");
  }
};

/**
 * GET /api/users/tradesmen
 * Public: lists tradesmen with their TradesmanDetails
 * Supports pagination: ?page=1&limit=10
 * Optional filter: tradeType (e.g. ?tradeType=plumber)
 */
exports.getAllTradesmen = async (req, res) => {
  try {
    const { page, limit, offset } = parsePagination(req);
    const { tradeType, search } = req.query;

    const whereUser = { role: "tradesman" };

    // If search on user fields
    if (search) {
      whereUser[Op.or] = [
        { name: { [Op.iLike]: `%${search}%` } },
        { email: { [Op.iLike]: `%${search}%` } },
        { mobile: { [Op.iLike]: `%${search}%` } },
      ];
    }

    // Filter on TradesmanDetails (tradeType)
    const tradesmanWhere = {};
    if (tradeType) tradesmanWhere.tradeType = tradeType;

    const result = await User.findAndCountAll({
      where: whereUser,
      include: [
        {
          model: TradesmanDetails,
          as: "TradesmanDetail",
          where: Object.keys(tradesmanWhere).length ? tradesmanWhere : undefined,
          required: false,
        },
      ],
      limit,
      offset,
      order: [['createdAt', 'DESC']],
    });

    if (!result || result.count === 0) {
      return sendResponse(res, 404, false, "No tradesmen found");
    }

    return paginatedResponse(res, "Tradesmen fetched", result, page, limit);
  } catch (error) {
    console.error("Fetch Tradesmen Error:", error);
    return sendResponse(res, 500, false, "Server error");
  }
};

/**
 * GET /api/users/clients
 * Public: lists clients (role = client)
 * Supports pagination ?page & ?limit
 */
exports.getAllClients = async (req, res) => {
  try {
    const { page, limit, offset } = parsePagination(req);
    const { search } = req.query;

    const where = { role: "client" };

    if (search) {
      where[Op.or] = [
        { name: { [Op.iLike]: `%${search}%` } },
        { email: { [Op.iLike]: `%${search}%` } },
        { mobile: { [Op.iLike]: `%${search}%` } },
      ];
    }

    const result = await User.findAndCountAll({
      where,
      limit,
      offset,
      order: [['createdAt', 'DESC']],
    });

    if (!result || result.count === 0) {
      return sendResponse(res, 404, false, "No clients found");
    }

    return paginatedResponse(res, "Clients fetched", result, page, limit);
  } catch (error) {
    console.error("Fetch Clients Error:", error);
    return sendResponse(res, 500, false, "Server error");
  }
};

exports.getUserById = async (req, res) => {
  try {
    const user = await User.findOne({
      where: { id: req.params.id },
      include: [{ model: TradesmanDetails, as: "TradesmanDetail" }],
    });

    if (!user) return sendResponse(res, 404, false, "User not found");

    return sendResponse(res, 200, true, "User fetched", user);
  } catch (error) {
    console.error("Fetch User Error:", error);
    return sendResponse(res, 500, false, "Server error");
  }
};

exports.updateProfile = async (req, res) => {
  try {
    const userId = req.user.id; // 🔥 TOKEN SE ID

    const user = await User.findByPk(userId);
    if (!user)
      return sendResponse(res, 404, false, "User not found");

    const {
      name,
      email,
      mobile,
      password,
      tradeType,
      businessName,
      shortBio,
      licenseNumber,
      licenseExpiry,
      isApproved
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
      user.profileImage = `/uploads/profile/${req.file.filename}`;
    }

    await user.save();

    // -------- TRADESMAN DETAILS (IF EXISTS) --------
    const tradesman = await TradesmanDetails.findOne({
      where: { userId }
    });

    if (tradesman) {
      if (tradeType !== undefined) tradesman.tradeType = tradeType;
      if (businessName !== undefined) tradesman.businessName = businessName;
      if (shortBio !== undefined) tradesman.shortBio = shortBio;
      if (licenseNumber !== undefined) tradesman.licenseNumber = licenseNumber;
      if (licenseExpiry !== undefined) tradesman.licenseExpiry = licenseExpiry;
      if (isApproved !== undefined) tradesman.isApproved = isApproved;

      await tradesman.save();
    }

    return sendResponse(res, 200, true, "Profile updated successfully", {
      id: user.id,
      name: user.name,
      email: user.email,
      mobile: user.mobile,
      profileImage: user.profileImage
    });

  } catch (error) {
    console.error("Update Profile Error:", error);
    return sendResponse(res, 500, false, "Server error");
  }
};

exports.deleteUser = async (req, res) => {
  try {
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
    const { email } = req.body;

    if (!email) return sendResponse(res, 400, false, "Email is required");

    const user = await User.findOne({ where: { email } });
    if (!user) return sendResponse(res, 404, false, "User not found");

    const token = crypto.randomBytes(32).toString("hex");
    const expiry = new Date(Date.now() + 15 * 60 * 1000);

    await user.update({
      resetPasswordToken: token,
      resetPasswordExpires: expiry,
    });

    const resetLink = `${process.env.FRONTEND_URL}/reset-password/${token}`;

    console.log("Reset Link:", resetLink);

    return sendResponse(res, 200, true, "Password reset link sent", resetLink);

  } catch (err) {
    console.error("Forgot Error:", err);
    return sendResponse(res, 500, false, "Server error");
  }
};

exports.resetPassword = async (req, res) => {
  try {
    const { token } = req.params;
    const { newPassword } = req.body;

    const user = await User.findOne({
      where: {
        resetPasswordToken: token,
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
    if (!isMatch) return sendResponse(res, 400, false, "Old password incorrect");

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

    // 🔥 RAW SEQUELIZE OBJECT RETURN
    return sendResponse(res, 200, true, "User fetched", user);

  } catch (error) {
    console.error(error);
    return sendResponse(res, 500, false, "Server error");
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
          attributes: ["tradeType", "businessName", "shortBio"],
        },
        {
          model: TravelPlan,
          as: "travelPlans", // ✅ FIXED ALIAS
          where: { status: "open" },
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
    const reviews = await Review.findAll({
      where: { toUserId: userId },
      attributes: ["rating"],
    });

    const avgRating =
      reviews.length > 0
        ? (
          reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length
        ).toFixed(1)
        : "0.0";

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
        profileImage: user.profileImage,
        tradeType: user.TradesmanDetail?.tradeType || null,
        description: user.TradesmanDetail?.shortBio || null,

        /* RATING */
        rating: avgRating,
        reviewCount: reviews.length,

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

exports.filterTradesmen = async (req, res) => {
  try {
    console.log("🔥 NEW FILTER CONTROLLER HIT 🔥");
    console.log("🔍 Incoming filter query:", req.query);

    const {
      tradeType,
      lat,
      lng,
      radius = 40,
      rating,
      verified,
      availability
    } = req.query;

    /* ================= BASIC SETUP ================= */

    const userLat = lat ? Number(lat) : null;
    const userLng = lng ? Number(lng) : null;
    const maxRadius = Number(radius);

    let whereUser = { role: "tradesman" };
    let whereTrade = {};

    /* ================= 1️⃣ TRADE TYPE FILTER ================= */

    if (tradeType) {
      const trades = tradeType.split(",").map(t => t.trim());
      whereTrade.tradeType = { [Op.in]: trades };
      console.log("✅ Trade types:", trades);
    }

    /* ================= 2️⃣ VERIFIED FILTER ================= */

    if (verified === "true") {
      whereTrade.isApproved = true;
      console.log("✅ Verified tradesmen only");
    }

    /* ================= 3️⃣ AVAILABILITY FILTER ================= */

    if (availability === "today") {
      const now = new Date();
      whereTrade.startDate = { [Op.lte]: now };
      whereTrade.endDate = { [Op.gte]: now };
      console.log("✅ Availability: today");
    }

    /* ================= 4️⃣ FETCH TRADESMEN ================= */

    let tradesmen = await User.findAll({
      where: whereUser,
      include: [
        {
          model: TradesmanDetails,
          as: "TradesmanDetail",
          where: whereTrade,
          required: true // IMPORTANT
        }
      ]
    });

    console.log(`📦 Tradesmen fetched from DB: ${tradesmen.length}`);

    if (!tradesmen.length) {
      return res.json({
        success: true,
        message: "No tradesmen found",
        data: []
      });
    }

    /* ================= 5️⃣ RATING FILTER (NO N+1) ================= */

    if (rating) {
      console.log(`⭐ Applying rating filter >= ${rating}`);

      const ratings = await Review.findAll({
        attributes: [
          "toUserId",
          [fn("AVG", col("rating")), "avgRating"]
        ],
        where: {
          toUserId: tradesmen.map(t => t.id)
        },
        group: ["toUserId"],
        raw: true
      });

      const ratingMap = Object.fromEntries(
        ratings.map(r => [r.toUserId, Number(r.avgRating)])
      );

      tradesmen = tradesmen.filter(t => {
        const avg = ratingMap[t.id] || 0;
        t.dataValues.avgRating = avg;
        return avg >= Number(rating);
      });

      console.log(`⭐ After rating filter: ${tradesmen.length}`);
    }

    /* ================= 6️⃣ GPS DISTANCE FILTER ================= */

    if (userLat !== null && userLng !== null) {
      console.log("📍 Applying GPS filter", {
        userLat,
        userLng,
        maxRadius
      });

      const R = 6371; // Earth radius in km

      tradesmen = tradesmen.filter(t => {
        const location = t.TradesmanDetail.currentLocation;
        if (!location) return false;

        const [tLat, tLng] = location.split(",").map(Number);
        if (!tLat || !tLng) return false;

        const dLat = (tLat - userLat) * Math.PI / 180;
        const dLng = (tLng - userLng) * Math.PI / 180;

        const a =
          Math.sin(dLat / 2) ** 2 +
          Math.cos(userLat * Math.PI / 180) *
          Math.cos(tLat * Math.PI / 180) *
          Math.sin(dLng / 2) ** 2;

        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        const distance = R * c;

        t.dataValues.distance = Number(distance.toFixed(2));

        return distance <= maxRadius;
      });

      console.log(`📍 After GPS filter: ${tradesmen.length}`);
    }

    /* ================= FINAL RESPONSE ================= */

    return res.json({
      success: true,
      message: "Filtered tradesmen",
      count: tradesmen.length,
      data: tradesmen
    });

  } catch (err) {
    console.error("❌ Filter Error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error"
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

    // ✅ ONLY filename (NO /uploads/)
    if (profileImageFile?.filename) {
      user.profileImage = profileImageFile.filename;
    }

    await user.save();

    /* ================= UPDATE TRADESMAN DETAILS ================= */
    if (tradeType !== undefined) tradesman.tradeType = tradeType;
    if (businessName !== undefined) tradesman.businessName = businessName;
    if (shortBio !== undefined) tradesman.shortBio = shortBio;
    if (licenseNumber !== undefined) tradesman.licenseNumber = licenseNumber;
    if (licenseExpiry !== undefined) tradesman.licenseExpiry = licenseExpiry;
    if (portfolioDescription !== undefined) {
      tradesman.portfolioDescription = portfolioDescription;
    }

    // ❌ licenseDocument update NOT allowed

    // ✅ PORTFOLIO PHOTOS → ONLY filenames, NO stringify
    if (portfolioFiles.length > 0) {
      tradesman.portfolioPhotos = portfolioFiles.map(
        (f) => f.filename
      );
    }

    await tradesman.save();

    /* ================= FINAL RESPONSE ================= */
    return sendResponse(res, 200, true, "Profile updated successfully", {
      user: {
        id: user.id,
        name: user.name,
        mobile: user.mobile,
        profileImage: user.profileImage, // e.g. "profileImage-176562030141.jpg"
      },
      tradesman: {
        tradeType: tradesman.tradeType,
        businessName: tradesman.businessName,
        shortBio: tradesman.shortBio,
        portfolioDescription: tradesman.portfolioDescription,
        licenseNumber: tradesman.licenseNumber,
        licenseExpiry: tradesman.licenseExpiry,
        portfolioPhotos: tradesman.portfolioPhotos || [], // ["img1.jpg","img2.jpg"]
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
      radius = 40,        // km
      tradeType,
      minRating = 0,
      onlyVerified = true,
      availability = "open"
    } = req.body;

    if (!latitude || !longitude) {
      return res.status(400).json({
        success: false,
        message: "Latitude & longitude required"
      });
    }

    // 🔥 distance formula (repeatable)
    const distanceSQL = `
      (6371 * acos(
        cos(radians(${latitude})) *
        cos(radians(travelPlans.latitude)) *
        cos(radians(travelPlans.longitude) - radians(${longitude})) +
        sin(radians(${latitude})) *
        sin(radians(travelPlans.latitude))
      ))
    `;

    const tradesmen = await User.findAll({
      where: { role: "tradesman" },
      attributes: ["id", "name", "profileImage"],

      include: [
        {
          model: TradesmanDetails,
          as: "TradesmanDetail",
          required: true,
          where: {
            ...(tradeType && { tradeType }),
            ...(onlyVerified && { isApproved: true })
          }
        },
        {
          model: TravelPlan,
          as: "travelPlans",
          required: true,
          where: {
            status: availability,
            latitude: { [Op.ne]: null },
            longitude: { [Op.ne]: null }
          },
          attributes: {
            include: [[literal(distanceSQL), "distance"]]
          }
        }
      ],

      // ✅ FIXED
      having: literal(`${distanceSQL} <= ${radius}`),
      order: [[literal(distanceSQL), "ASC"]]
    });

    // ⭐ Rating filter (post-processing)
    const result = await Promise.all(
      tradesmen.map(async (t) => {
        const ratingAgg = await Review.findOne({
          where: { toUserId: t.id },
          attributes: [
            [fn("AVG", col("rating")), "avgRating"],
            [fn("COUNT", col("id")), "reviewCount"]
          ],
          raw: true
        });

        const rating = ratingAgg?.avgRating
          ? Number(ratingAgg.avgRating)
          : 0;

        if (rating < minRating) return null;

        return {
          id: t.id,
          name: t.name,
          profileImage: t.profileImage,
          tradeType: t.TradesmanDetail.tradeType,
          businessName: t.TradesmanDetail.businessName,
          rating: rating.toFixed(1),
          reviewCount: ratingAgg?.reviewCount || 0,
          distance: Number(
            t.travelPlans[0].get("distance")
          ).toFixed(2),
          availability: "Available"
        };
      })
    );

    return res.json({
      success: true,
      message: "Filtered tradesmen fetched",
      data: result.filter(Boolean)
    });

  } catch (err) {
    console.error("Filter error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error"
    });
  }
};




