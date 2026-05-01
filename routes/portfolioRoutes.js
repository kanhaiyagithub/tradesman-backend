const express = require("express");
const router = express.Router();

const portfolioController = require("../controllers/portfolioController");
const { verifyToken } = require("../middlewares/authMiddleware");

const { upload, convertToJpg } = require("../middlewares/uploadMiddleware");

// ===============================
// ADD portfolio photos
// ===============================
router.post(
  "/portfolioPhotos",
  verifyToken,
  upload.array("photos", 10),
  convertToJpg,
  portfolioController.addPortfolioPhotos
);

// ===============================
// GET my portfolio
// ===============================
router.get(
  "/portfolioPhotos",
  verifyToken,
  portfolioController.getMyPortfolio
);

// ===============================
// DELETE portfolio photo
// ===============================
router.delete(
  "/portfolioPhotos/:index",
  verifyToken,
  portfolioController.deletePortfolioPhoto
);

module.exports = router;
