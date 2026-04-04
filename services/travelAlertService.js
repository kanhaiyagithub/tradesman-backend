const ClientTradeAlert = require("../models/clientTradeAlertModel");
const TravelPlanAlertMatch = require("../models/travelPlanAlertMatchModel");
const TradesmanDetails = require("../models/TradesmanDetails");
const {
  sendPushNotification,
} = require("../controllers/notificationController");

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

function isDateMatch(jobStartDate, jobEndDate, pointDateTime) {
  // No date filter → always match
  if (!jobStartDate && !jobEndDate) return true;

  // If client cares about date but point has no time → reject
  if (!pointDateTime) return false;

  const pointTime = new Date(pointDateTime).getTime();

  if (jobStartDate) {
    const startTime = new Date(jobStartDate).getTime();
    if (pointTime < startTime) return false;
  }

  if (jobEndDate) {
    const endTime = new Date(jobEndDate).getTime();
    if (pointTime > endTime) return false;
  }

  return true;
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
    console.log("🔍 Running travel plan matching...", {
      travelPlanId: travelPlan.id,
      tradesmanId: travelPlan.tradesmanId,
    });

    const tradesman = await TradesmanDetails.findOne({
      where: { userId: travelPlan.tradesmanId },
    });

    if (!tradesman) {
      console.log("❌ Tradesman details not found", {
        tradesmanId: travelPlan.tradesmanId,
      });
      return;
    }

    const tradeTypeId = Number(tradesman.tradeTypeId);

    if (!tradeTypeId) {
      console.log("❌ Tradesman tradeTypeId missing", {
        tradesmanId: travelPlan.tradesmanId,
      });
      return;
    }

    const alerts = await ClientTradeAlert.findAll({
      where: { isActive: true },
    });

    const travelPoints = getTravelPoints(travelPlan);

    if (!travelPoints.length) {
      console.log("❌ No valid travel points found", {
        travelPlanId: travelPlan.id,
      });
      return;
    }

    for (const alert of alerts) {
      try {
        if (Number(alert.tradeTypeId) !== tradeTypeId) {
          continue;
        }

        const existing = await TravelPlanAlertMatch.findOne({
          where: {
            travelPlanId: travelPlan.id,
            clientTradeAlertId: alert.id,
          },
        });

        if (existing) {
          console.log("ℹ️ Match already exists, skipping", {
            travelPlanId: travelPlan.id,
            clientTradeAlertId: alert.id,
            matchId: existing.id,
          });
          continue;
        }

        let bestMatch = null;

        for (const point of travelPoints) {
          const distance = getDistanceKm(
            Number(alert.latitude),
            Number(alert.longitude),
            point.latitude,
            point.longitude,
          );

          if (distance <= Number(alert.radiusKm)) {
            // 🔥 DATE CHECK ADDED
            const dateValid = isDateMatch(
              alert.startDate,
              alert.endDate,
              point.expectedDateTime,
            );

            if (!dateValid) {
              console.log("⏳ Date condition failed", {
                clientId: alert.clientId,
                pointName: point.name,
                pointDate: point.expectedDateTime,
                jobStartDate: alert.startDate,
                jobEndDate: alert.endDate,
              });
              continue;
            }

            if (!bestMatch || distance < bestMatch.distance) {
              bestMatch = {
                point,
                distance,
              };
            }
          }
        }

        if (!bestMatch) {
          continue;
        }

        const match = await TravelPlanAlertMatch.create({
          travelPlanId: travelPlan.id,
          tradesmanId: travelPlan.tradesmanId,
          clientId: alert.clientId,
          clientTradeAlertId: alert.id,
          matchedStopName: bestMatch.point.name,
          matchedLatitude: bestMatch.point.latitude,
          matchedLongitude: bestMatch.point.longitude,
          matchedDistanceKm: Number(bestMatch.distance.toFixed(2)),
          estimatedArrivalDate: bestMatch.point.expectedDateTime,
          notificationSent: false,
          status: "pending",
        });

        console.log("✅ Match created", {
          matchId: match.id,
          clientId: alert.clientId,
          travelPlanId: travelPlan.id,
          matchedStopName: bestMatch.point.name,
          matchedDistanceKm: Number(bestMatch.distance.toFixed(2)),
        });

        const pushTitle = "Tradesman available near you";
        const pushBody = `A tradesman is expected near ${bestMatch.point.name}. Tap to view details.`;

        const pushResult = await sendPushNotification(
          alert.clientId,
          pushTitle,
          pushBody,
          {
            type: "travel_match",
            matchId: match.id,
            travelPlanId: travelPlan.id,
            clientTradeAlertId: alert.id,
            matchedStopName: bestMatch.point.name,
            estimatedArrivalDate: bestMatch.point.expectedDateTime || "",
          },
        );

        if (pushResult.success) {
          await match.update({
            notificationSent: true,
            notificationSentAt: new Date(),
            status: "notified",
          });

          console.log("📲 Push sent and match updated", {
            matchId: match.id,
            clientId: alert.clientId,
            sentCount: pushResult.sentCount,
            failureCount: pushResult.failureCount,
          });
        } else {
          console.log("⚠️ Push not sent, match kept pending", {
            matchId: match.id,
            clientId: alert.clientId,
            reason: pushResult.reason,
          });
        }
      } catch (innerError) {
        console.error("❌ Error while processing alert", {
          travelPlanId: travelPlan.id,
          clientTradeAlertId: alert.id,
          clientId: alert.clientId,
          error: innerError.message,
        });
      }
    }
  } catch (error) {
    console.error("❌ Matching error:", error);
  }
};
