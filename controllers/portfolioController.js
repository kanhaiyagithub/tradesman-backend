const TradesmanDetails = require("../models/TradesmanDetails");
const storageService = require("../services/storage/storageService");

const sendResponse = (res, status, success, message, data = null) =>
  res.status(status).json({ success, message, data });

/**
 * Resolves stored portfolio photo values into public URLs.
 *
 * @param {string[]} photos - Stored portfolio photo keys or legacy values.
 * @returns {string[]} Publicly accessible URLs.
 */
const toPublicPortfolioPhotos = (photos = []) =>
  storageService.toPublicUrls(photos, { category: "portfolio" });

exports.addPortfolioPhotos = async (req, res) => {
  try {
    const userId = req.user.id;

    if (!req.files || req.files.length === 0) {
      return sendResponse(res, 400, false, "No photos uploaded");
    }

    const tradesman = await TradesmanDetails.findOne({
      where: { userId },
    });

    if (!tradesman) {
      return sendResponse(res, 404, false, "Tradesman details not found");
    }

    const existingPhotos = Array.isArray(tradesman.portfolioPhotos)
      ? tradesman.portfolioPhotos
      : [];

    if (existingPhotos.length + req.files.length > 10) {
      return sendResponse(res, 400, false, "Max 10 portfolio photos allowed");
    }

    const savedPhotos = await storageService.saveMultipleImages({
      files: req.files,
      category: "portfolio",
    });

    tradesman.portfolioPhotos = [...existingPhotos, ...savedPhotos];
    await tradesman.save();

    return sendResponse(
      res,
      200,
      true,
      "Portfolio photos added",
      toPublicPortfolioPhotos(tradesman.portfolioPhotos)
    );
  } catch (err) {
    console.error(err);
    return sendResponse(res, 500, false, "Server error");
  }
};

exports.getMyPortfolio = async (req, res) => {
  try {
    const userId = req.user.id;

    const tradesman = await TradesmanDetails.findOne({
      where: { userId },
    });

    if (!tradesman) {
      return sendResponse(res, 404, false, "Tradesman details not found");
    }

    return sendResponse(
      res,
      200,
      true,
      "Portfolio fetched",
      toPublicPortfolioPhotos(tradesman.portfolioPhotos || [])
    );
  } catch (err) {
    return sendResponse(res, 500, false, "Server error");
  }
};

exports.deletePortfolioPhoto = async (req, res) => {
  try {
    const userId = req.user.id;
    const index = parseInt(req.params.index, 10);

    const tradesman = await TradesmanDetails.findOne({
      where: { userId },
    });

    if (!tradesman) {
      return sendResponse(res, 404, false, "Tradesman details not found");
    }

    const photos = Array.isArray(tradesman.portfolioPhotos)
      ? [...tradesman.portfolioPhotos]
      : [];

    if (Number.isNaN(index) || index < 0 || index >= photos.length) {
      return sendResponse(res, 400, false, "Invalid photo index");
    }

    const [removedPhoto] = photos.splice(index, 1);
    tradesman.portfolioPhotos = photos;
    await tradesman.save();
    await storageService.deleteObject(removedPhoto, { category: "portfolio" });

    return sendResponse(
      res,
      200,
      true,
      "Portfolio photo deleted",
      toPublicPortfolioPhotos(photos)
    );
  } catch (err) {
    return sendResponse(res, 500, false, "Server error");
  }
};
