const ClientTradeAlert = require("../models/clientTradeAlertModel");
const TradesmanDetails = require("../models/TradesmanDetails");
const TravelPlan = require("../models/locationModel");
const TradesmanLiveLocation = require("../models/TradesmanLiveLocation");
const LiveProximityNotification = require("../models/LiveProximityNotification");
const TravelPlanAlertMatch = require("../models/travelPlanAlertMatchModel");
const User = require("../models/User");
const {
  buildActiveOrUpcomingPlanWhere,
  refreshTravelPlanStatuses,
} = require("./travelPlanStatusService");
const {
  sendPushNotification,
} = require("../controllers/notificationController");
const {
  sendTradesmanEnteredRadiusEmail,
} = require("./emailService");

const COOLDOWN_MINUTES = 30;

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

function isCooldownActive(lastNotifiedAt) {
  if (!lastNotifiedAt) return false;

  const lastTime = new Date(lastNotifiedAt).getTime();
  const now = Date.now();

  return now - lastTime < COOLDOWN_MINUTES * 60 * 1000;
}

async function processLiveLocation({ tradesmanId, latitude, longitude }) {
  console.log("[LIVE] Processing live location", {
    tradesmanId,
    latitude,
    longitude,
    at: new Date().toISOString(),
  });

  const tradesman = await TradesmanDetails.findOne({
    where: { userId: tradesmanId },
  });

  if (!tradesman) {
    console.log("[LIVE] Tradesman details not found", { tradesmanId });
    return { success: false, reason: "TRADESMAN_DETAILS_NOT_FOUND" };
  }

  const tradeTypeId = Number(tradesman.tradeTypeId);

  if (!tradeTypeId) {
    console.log("[LIVE] Tradesman tradeTypeId missing", { tradesmanId });
    return { success: false, reason: "TRADE_TYPE_MISSING" };
  }

  const now = new Date();

  await refreshTravelPlanStatuses({ tradesmanId, now });

  const activeTravelPlan = await TravelPlan.findOne({
    where: buildActiveOrUpcomingPlanWhere(tradesmanId, now),
    order: [["id", "DESC"]],
  });

  if (!activeTravelPlan) {
    console.log("[LIVE] No active travel plan found, skipping live proximity", {
      tradesmanId,
    });
    return { success: false, reason: "NO_ACTIVE_TRAVEL_PLAN" };
  }

  await TradesmanLiveLocation.upsert({
    tradesmanId,
    travelPlanId: activeTravelPlan.id,
    latitude,
    longitude,
    updatedAt: new Date(),
  });

  console.log("[LIVE] Live location saved", {
    tradesmanId,
    travelPlanId: activeTravelPlan.id,
  });

  const alerts = await ClientTradeAlert.findAll({
    where: {
      isActive: true,
      tradeTypeId,
    },
  });

  let matchedCount = 0;
  let notifiedCount = 0;
  let cooldownSkippedCount = 0;

  for (const alert of alerts) {
    try {
      const distance = getDistanceKm(
        Number(alert.latitude),
        Number(alert.longitude),
        Number(latitude),
        Number(longitude),
      );

      console.log("[LIVE] Alert distance checked", {
        tradesmanId,
        travelPlanId: activeTravelPlan.id,
        clientId: alert.clientId,
        clientTradeAlertId: alert.id,
        distanceKm: Number(distance.toFixed(2)),
        radiusKm: Number(alert.radiusKm),
      });

      if (distance > Number(alert.radiusKm)) {
        continue;
      }

      const existingMatch = await TravelPlanAlertMatch.findOne({
        where: {
          travelPlanId: activeTravelPlan.id,
          clientTradeAlertId: alert.id,
          clientId: alert.clientId,
          tradesmanId,
        },
      });

      if (!existingMatch) {
        console.log("[LIVE] Tradesman is inside radius but no stored match exists, skipping email-only match flow", {
          tradesmanId,
          travelPlanId: activeTravelPlan.id,
          clientId: alert.clientId,
          clientTradeAlertId: alert.id,
        });
        continue;
      }

      matchedCount++;

      const existingNotification = await LiveProximityNotification.findOne({
        where: {
          travelPlanId: activeTravelPlan.id,
          clientId: alert.clientId,
        },
      });

      if (
        existingNotification &&
        isCooldownActive(existingNotification.lastNotifiedAt)
      ) {
        cooldownSkippedCount++;

        console.log("[LIVE] Cooldown active, skipping notification", {
          tradesmanId,
          travelPlanId: activeTravelPlan.id,
          clientId: alert.clientId,
          clientTradeAlertId: alert.id,
          lastNotifiedAt: existingNotification.lastNotifiedAt,
          cooldownMinutes: COOLDOWN_MINUTES,
        });
        continue;
      }

      const pushTitle = "Tradesman nearby now";
      const pushBody =
        "A tradesman is currently near your location. Contact now!";

      const pushResult = await sendPushNotification(
        alert.clientId,
        pushTitle,
        pushBody,
        {
          type: "live_proximity",
          tradesmanId,
          travelPlanId: activeTravelPlan.id,
          clientTradeAlertId: alert.id,
          distanceKm: Number(distance.toFixed(2)),
          latitude,
          longitude,
        },
      );

      if (pushResult.success) {
        if (existingNotification) {
          await existingNotification.update({
            tradesmanId,
            clientTradeAlertId: alert.id,
            lastNotifiedAt: new Date(),
          });
        } else {
          await LiveProximityNotification.create({
            tradesmanId,
            travelPlanId: activeTravelPlan.id,
            clientId: alert.clientId,
            clientTradeAlertId: alert.id,
            lastNotifiedAt: new Date(),
          });
        }

        notifiedCount++;

        console.log("[LIVE] Live proximity notification sent", {
          tradesmanId,
          travelPlanId: activeTravelPlan.id,
          clientId: alert.clientId,
          clientTradeAlertId: alert.id,
          distanceKm: Number(distance.toFixed(2)),
        });

        try {
          const [client, tradesmanUser] = await Promise.all([
            User.findByPk(alert.clientId),
            User.findByPk(tradesmanId),
          ]);

          await sendTradesmanEnteredRadiusEmail({
            alert,
            travelPlan: activeTravelPlan,
            client,
            tradesman: tradesmanUser,
            distanceKm: Number(distance.toFixed(2)),
          });
        } catch (emailError) {
          console.error("[LIVE] Live proximity email failed", {
            tradesmanId,
            travelPlanId: activeTravelPlan.id,
            clientId: alert.clientId,
            clientTradeAlertId: alert.id,
            error: emailError.message,
          });
        }
      } else {
        console.log("[LIVE] Push failed for live proximity", {
          tradesmanId,
          travelPlanId: activeTravelPlan.id,
          clientId: alert.clientId,
          clientTradeAlertId: alert.id,
          reason: pushResult.reason,
        });
      }
    } catch (innerError) {
      console.error("[LIVE ERROR] Error while processing live alert", {
        tradesmanId,
        alertId: alert.id,
        clientId: alert.clientId,
        error: innerError.message,
      });
    }
  }

  return {
    success: true,
    travelPlanId: activeTravelPlan.id,
    matchedCount,
    notifiedCount,
    cooldownSkippedCount,
  };
}

module.exports = {
  processLiveLocation,
};