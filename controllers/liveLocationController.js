const { processLiveLocation } = require("../services/liveLocationService");

exports.updateLiveLocation = async (req, res) => {
  try {
    const tradesmanId = req.user.id;
    const { latitude, longitude } = req.body;

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

    const lat = Number(latitude);
    const lng = Number(longitude);

    if (Number.isNaN(lat) || Number.isNaN(lng)) {
      return res.status(400).json({
        success: false,
        message: "latitude and longitude must be valid numbers",
      });
    }

    const result = await processLiveLocation({
      tradesmanId,
      latitude: lat,
      longitude: lng,
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
      message: error.message
    //   message: "Failed to process live location",
    });
  }
};
