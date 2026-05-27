const ClientTradeAlert = require("../models/clientTradeAlertModel");
const {
  matchClientTradeAlertWithTravelPlans,
} = require("../services/travelAlertService");

const sendResponse = (res, statusCode, success, message, data = null) =>
  res.status(statusCode).json({ success, message, data });

const normalizeTradeType = (value) => {
  if (!value || typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized || null;
};

/**
 * Validates an optional date value sent by the mobile app or Postman.
 *
 * @param {string|Date|null|undefined} value - Incoming date value.
 * @returns {boolean} True when the value is empty or parseable as a Date.
 */
const isValidOptionalDate = (value) => {
  if (value === undefined || value === null || value === "") return true;
  return !Number.isNaN(new Date(value).getTime());
};

/**
 * Runs matching after an alert change without making the client-alert API fail
 * because of a notification or matching-side issue. The matching service catches
 * its own errors, and this wrapper keeps the controller response predictable.
 *
 * @param {import("sequelize").Model} alert - Saved ClientTradeAlert instance.
 * @returns {Promise<void>}
 */
const runAlertMatching = async (alert) => {
  try {
    console.log("[TRAVEL_ALERT] Client-alert API triggered matching", {
      clientTradeAlertId: alert?.id,
      clientId: alert?.clientId,
      tradeTypeId: alert?.tradeTypeId,
      radiusKm: alert?.radiusKm,
      isActive: alert?.isActive,
    });

    const summary = await matchClientTradeAlertWithTravelPlans(alert);

    console.log("[TRAVEL_ALERT] Client-alert API matching completed", {
      clientTradeAlertId: alert?.id,
      clientId: alert?.clientId,
      ...summary,
    });
  } catch (error) {
    console.error("[TRAVEL_ALERT] Client-alert API matching failed", {
      clientTradeAlertId: alert?.id,
      clientId: alert?.clientId,
      error: error.message,
    });
  }
};

exports.createClientTradeAlert = async (req, res) => {
  try {
    const { id: userId, role } = req.user;

    if (role !== "client") {
      return sendResponse(res, 403, false, "Only clients can create trade alerts");
    }

    const {
      tradeType,
      tradeTypeId,
      locationName,
      latitude,
      longitude,
      radiusKm,
      startDate,
      endDate,
    } = req.body;

    if (
      tradeTypeId === undefined ||
      tradeTypeId === null ||
      !locationName ||
      latitude === undefined ||
      longitude === undefined
    ) {
      return sendResponse(
        res,
        400,
        false,
        "tradeTypeId, locationName, latitude and longitude are required"
      );
    }

    if (Number.isNaN(Number(tradeTypeId))) {
      return sendResponse(res, 400, false, "tradeTypeId must be a valid number");
    }

    if (Number.isNaN(Number(latitude)) || Number.isNaN(Number(longitude))) {
      return sendResponse(res, 400, false, "latitude and longitude must be valid numbers");
    }

    if (radiusKm !== undefined && Number(radiusKm) <= 0) {
      return sendResponse(res, 400, false, "radiusKm must be greater than 0");
    }

    if (!isValidOptionalDate(startDate) || !isValidOptionalDate(endDate)) {
      return sendResponse(res, 400, false, "startDate and endDate must be valid dates");
    }

    if (startDate && endDate && new Date(startDate) > new Date(endDate)) {
      return sendResponse(res, 400, false, "startDate cannot be after endDate");
    }

    const alert = await ClientTradeAlert.create({
      clientId: userId,
      tradeType: normalizeTradeType(tradeType),
      tradeTypeId: Number(tradeTypeId),
      locationName: String(locationName).trim(),
      latitude: Number(latitude),
      longitude: Number(longitude),
      radiusKm: radiusKm !== undefined ? Number(radiusKm) : 15,
      startDate: startDate || null,
      endDate: endDate || null,
      isActive: true,
    });

    await runAlertMatching(alert);

    return sendResponse(res, 201, true, "Client trade alert created", alert);
  } catch (error) {
    console.error("createClientTradeAlert error:", error);
    return sendResponse(res, 500, false, "Server error");
  }
};

exports.getMyClientTradeAlerts = async (req, res) => {
  try {
    const { id: userId, role } = req.user;

    if (role !== "client") {
      return sendResponse(res, 403, false, "Only clients can view trade alerts");
    }

    const alerts = await ClientTradeAlert.findAll({
      where: { clientId: userId },
      order: [["createdAt", "DESC"]],
    });

    return sendResponse(res, 200, true, "My client trade alerts", alerts);
  } catch (error) {
    console.error("getMyClientTradeAlerts error:", error);
    return sendResponse(res, 500, false, "Server error");
  }
};

exports.updateClientTradeAlert = async (req, res) => {
  try {
    const { id: userId, role } = req.user;
    const { id } = req.params;

    if (role !== "client") {
      return sendResponse(res, 403, false, "Only clients can update trade alerts");
    }

    const alert = await ClientTradeAlert.findOne({
      where: { id, clientId: userId },
    });

    if (!alert) {
      return sendResponse(res, 404, false, "Trade alert not found");
    }

    const {
      tradeType,
      tradeTypeId,
      locationName,
      latitude,
      longitude,
      radiusKm,
      startDate,
      endDate,
      isActive,
    } = req.body;

    if (tradeType !== undefined) {
      alert.tradeType = normalizeTradeType(tradeType);
    }

    if (tradeTypeId !== undefined) {
      if (tradeTypeId === null || Number.isNaN(Number(tradeTypeId))) {
        return sendResponse(res, 400, false, "tradeTypeId must be a valid number");
      }
      alert.tradeTypeId = Number(tradeTypeId);
    }

    if (locationName !== undefined) {
      if (!String(locationName).trim()) {
        return sendResponse(res, 400, false, "locationName cannot be empty");
      }
      alert.locationName = String(locationName).trim();
    }

    if (latitude !== undefined) {
      if (Number.isNaN(Number(latitude))) {
        return sendResponse(res, 400, false, "latitude must be a valid number");
      }
      alert.latitude = Number(latitude);
    }

    if (longitude !== undefined) {
      if (Number.isNaN(Number(longitude))) {
        return sendResponse(res, 400, false, "longitude must be a valid number");
      }
      alert.longitude = Number(longitude);
    }

    if (radiusKm !== undefined) {
      if (Number(radiusKm) <= 0) {
        return sendResponse(res, 400, false, "radiusKm must be greater than 0");
      }
      alert.radiusKm = Number(radiusKm);
    }

    if (startDate !== undefined) {
      if (!isValidOptionalDate(startDate)) {
        return sendResponse(res, 400, false, "startDate must be a valid date");
      }
      alert.startDate = startDate || null;
    }

    if (endDate !== undefined) {
      if (!isValidOptionalDate(endDate)) {
        return sendResponse(res, 400, false, "endDate must be a valid date");
      }
      alert.endDate = endDate || null;
    }

    if (isActive !== undefined) {
      alert.isActive = Boolean(isActive);
    }

    if (alert.startDate && alert.endDate && new Date(alert.startDate) > new Date(alert.endDate)) {
      return sendResponse(res, 400, false, "startDate cannot be after endDate");
    }

    await alert.save();

    if (alert.isActive) {
      await runAlertMatching(alert);
    }

    return sendResponse(res, 200, true, "Trade alert updated", alert);
  } catch (error) {
    console.error("updateClientTradeAlert error:", error);
    return sendResponse(res, 500, false, "Server error");
  }
};

exports.toggleClientTradeAlert = async (req, res) => {
  try {
    const { id: userId, role } = req.user;
    const { id } = req.params;

    if (role !== "client") {
      return sendResponse(res, 403, false, "Only clients can toggle trade alerts");
    }

    const alert = await ClientTradeAlert.findOne({
      where: { id, clientId: userId },
    });

    if (!alert) {
      return sendResponse(res, 404, false, "Trade alert not found");
    }

    alert.isActive = !alert.isActive;
    await alert.save();

    if (alert.isActive) {
      await runAlertMatching(alert);
    }

    return sendResponse(
      res,
      200,
      true,
      `Trade alert ${alert.isActive ? "activated" : "deactivated"}`,
      alert
    );
  } catch (error) {
    console.error("toggleClientTradeAlert error:", error);
    return sendResponse(res, 500, false, "Server error");
  }
};

exports.deleteClientTradeAlert = async (req, res) => {
  try {
    const { id: userId, role } = req.user;
    const { id } = req.params;

    if (role !== "client") {
      return sendResponse(res, 403, false, "Only clients can delete trade alerts");
    }

    const alert = await ClientTradeAlert.findOne({
      where: { id, clientId: userId },
    });

    if (!alert) {
      return sendResponse(res, 404, false, "Trade alert not found");
    }

    await alert.destroy();

    return sendResponse(res, 200, true, "Trade alert deleted");
  } catch (error) {
    console.error("deleteClientTradeAlert error:", error);
    return sendResponse(res, 500, false, "Server error");
  }
};