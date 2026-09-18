const { processLiveLocation } = require("../services/liveLocationService");
const { parseLiveCoordinates } = require("../utils/liveLocationValidation");

exports.updateLiveLocation = async (req, res) => {
  try {
    const tradesmanId = req.user.id;
    const role = req.user.role;
    const { latitude, longitude } = req.body;

    if (role !== "tradesman") {
      return res.status(403).json({
        success: false,
        message: "Only tradesmen can update live location",
      });
    }

    if (
      latitude === undefined ||
      latitude === null ||
      longitude === undefined ||
      longitude === null
    ) {
      return res.status(400).json({
        success: false,
        message: "latitude and longitude are required",
      });
    }

    const parsedCoordinates = parseLiveCoordinates({ latitude, longitude });
    if (!parsedCoordinates.success) {
      return res.status(400).json({
        success: false,
        message: parsedCoordinates.message,
      });
    }

    const result = await processLiveLocation({
      tradesmanId,
      latitude: parsedCoordinates.latitude,
      longitude: parsedCoordinates.longitude,
    });

    return res.json({
      success: true,
      message: "Live location processed successfully",
      data: result,
    });
  } catch (error) {
    console.error("[LIVE CONTROLLER ERROR]", {
      message: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      success: false,
      message: "Failed to process live location",
    });
  }
};
