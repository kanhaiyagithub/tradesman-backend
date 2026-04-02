const ClientTradeAlert = require("../models/clientTradeAlertModel");
const TravelPlanAlertMatch = require("../models/travelPlanAlertMatchModel");
const TradesmanDetails = require("../models/TradesmanDetails");

function getDistanceKm(lat1, lon1, lat2, lon2) {
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
}

function getTravelPoints(travelPlan) {
  const points = [];

  // START POINT
  if (
    travelPlan.latitude !== null &&
    travelPlan.latitude !== undefined &&
    travelPlan.longitude !== null &&
    travelPlan.longitude !== undefined &&
    !Number.isNaN(Number(travelPlan.latitude)) &&
    !Number.isNaN(Number(travelPlan.longitude))
  ) {
    points.push({
      type: "start",
      name:
        travelPlan.startLocation ||
        travelPlan.currentLocation ||
        "Start Location",
      latitude: Number(travelPlan.latitude),
      longitude: Number(travelPlan.longitude),
      expectedDateTime: travelPlan.startDateTime || null,
    });
  }

  // STOPS
  if (travelPlan.allowStops && Array.isArray(travelPlan.stops)) {
    for (const stop of travelPlan.stops) {
      if (!stop || typeof stop !== "object") continue;

      if (
        stop.latitude === null ||
        stop.latitude === undefined ||
        stop.longitude === null ||
        stop.longitude === undefined ||
        Number.isNaN(Number(stop.latitude)) ||
        Number.isNaN(Number(stop.longitude))
      ) {
        continue;
      }

      points.push({
        type: "stop",
        name: stop.name || "Stop",
        latitude: Number(stop.latitude),
        longitude: Number(stop.longitude),
        expectedDateTime:
          stop.expectedDateTime || travelPlan.startDateTime || null,
      });
    }
  }

  // DESTINATION
  if (
    travelPlan.destinationLatitude !== null &&
    travelPlan.destinationLatitude !== undefined &&
    travelPlan.destinationLongitude !== null &&
    travelPlan.destinationLongitude !== undefined &&
    !Number.isNaN(Number(travelPlan.destinationLatitude)) &&
    !Number.isNaN(Number(travelPlan.destinationLongitude))
  ) {
    points.push({
      type: "destination",
      name: travelPlan.destination || "Destination",
      latitude: Number(travelPlan.destinationLatitude),
      longitude: Number(travelPlan.destinationLongitude),
      expectedDateTime: travelPlan.destinationDateTime || null,
    });
  }

  return points;
}

exports.matchTravelPlanWithAlerts = async (travelPlan) => {
  try {
    console.log("🔍 Running travel plan matching...");

    const tradesman = await TradesmanDetails.findOne({
      where: { userId: travelPlan.tradesmanId },
    });

    if (!tradesman) {
      console.log("❌ Tradesman not found");
      return;
    }

    const tradeTypeId = Number(tradesman.tradeTypeId);
    if (!tradeTypeId) {
      console.log("❌ Tradesman tradeTypeId missing");
      return;
    }

    const alerts = await ClientTradeAlert.findAll({
      where: { isActive: true },
    });

    const travelPoints = getTravelPoints(travelPlan);

    if (!travelPoints.length) {
      console.log("❌ No valid travel points found");
      return;
    }

    for (const alert of alerts) {
      if (Number(alert.tradeTypeId) !== tradeTypeId) continue;

      const existing = await TravelPlanAlertMatch.findOne({
        where: {
          travelPlanId: travelPlan.id,
          clientTradeAlertId: alert.id,
        },
      });

      if (existing) continue;

      let bestMatch = null;

      for (const point of travelPoints) {
        const distance = getDistanceKm(
          Number(alert.latitude),
          Number(alert.longitude),
          point.latitude,
          point.longitude
        );

        if (distance <= Number(alert.radiusKm)) {
          if (!bestMatch || distance < bestMatch.distance) {
            bestMatch = {
              point,
              distance,
            };
          }
        }
      }

      if (!bestMatch) continue;

      await TravelPlanAlertMatch.create({
        travelPlanId: travelPlan.id,
        tradesmanId: travelPlan.tradesmanId,
        clientId: alert.clientId,
        clientTradeAlertId: alert.id,
        matchedStopName: bestMatch.point.name,
        matchedLatitude: bestMatch.point.latitude,
        matchedLongitude: bestMatch.point.longitude,
        matchedDistanceKm: Number(bestMatch.distance.toFixed(2)),
        estimatedArrivalDate: bestMatch.point.expectedDateTime,
      });

      console.log(
        `✅ Match found: Client ${alert.clientId} ↔ TravelPlan ${travelPlan.id} at ${bestMatch.point.name}`
      );
    }
  } catch (error) {
    console.error("❌ Matching error:", error);
  }
};