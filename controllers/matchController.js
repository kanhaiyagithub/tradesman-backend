const TravelPlanAlertMatch = require("../models/travelPlanAlertMatchModel");

exports.getMyAlertMatches = async (req, res) => {
  try {
    const clientId = req.user.id;

    const matches = await TravelPlanAlertMatch.findAll({
      where: { clientId },
      order: [["createdAt", "DESC"]],
    });

    return res.json({
      success: true,
      count: matches.length,
      data: matches,
    });
  } catch (error) {
    console.error("[GET CLIENT MATCHES ERROR]", error.message);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch matches",
    });
  }
};

exports.getMyRouteMatches = async (req, res) => {
  try {
    const tradesmanId = req.user.id;

    const matches = await TravelPlanAlertMatch.findAll({
      where: { tradesmanId },
      order: [["createdAt", "DESC"]],
    });

    return res.json({
      success: true,
      count: matches.length,
      data: matches,
    });
  } catch (error) {
    console.error("[GET TRADESMAN MATCHES ERROR]", error.message);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch matches",
    });
  }
};