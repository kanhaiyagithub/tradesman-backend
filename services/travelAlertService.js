const { Op } = require("sequelize");
const ClientTradeAlert = require("../models/clientTradeAlertModel");
const TravelPlan = require("../models/locationModel");
const TravelPlanAlertMatch = require("../models/travelPlanAlertMatchModel");
const TradesmanDetails = require("../models/TradesmanDetails");
const {
  sendPushNotification,
} = require("../controllers/notificationController");
const {
  ACTIVE_TRAVEL_PLAN_STATUSES,
  refreshTravelPlanStatuses,
} = require("./travelPlanStatusService");

/**
 * Calculates the distance between two coordinates using the Haversine formula.
 *
 * @param {number} lat1 - First latitude.
 * @param {number} lon1 - First longitude.
 * @param {number} lat2 - Second latitude.
 * @param {number} lon2 - Second longitude.
 * @returns {number} Distance in kilometers.
 */
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

/**
 * Checks whether the tradesman's expected arrival time falls inside the client's
 * requested alert window.
 *
 * @param {Date|string|null} jobStartDate - Client requested start date/time.
 * @param {Date|string|null} jobEndDate - Client requested end date/time.
 * @param {Date|string|null} pointDateTime - Expected tradesman arrival date/time.
 * @returns {boolean} True when the point time satisfies the alert window.
 */
function isDateMatch(jobStartDate, jobEndDate, pointDateTime) {
  // No date filter means the client is open to any arrival time.
  if (!jobStartDate && !jobEndDate) return true;

  // If the client supplied a date constraint, an undated route point is unsafe.
  if (!pointDateTime) return false;

  const pointTime = new Date(pointDateTime).getTime();

  if (Number.isNaN(pointTime)) return false;

  if (jobStartDate) {
    const startTime = new Date(jobStartDate).getTime();
    if (Number.isNaN(startTime) || pointTime < startTime) return false;
  }

  if (jobEndDate) {
    const endTime = new Date(jobEndDate).getTime();
    if (Number.isNaN(endTime) || pointTime > endTime) return false;
  }

  return true;
}

/**
 * Builds all route points that can match a client alert: start, stops, and
 * destination. Each point carries the tradesman's expected arrival time.
 *
 * @param {import('sequelize').Model} travelPlan - TravelPlan model instance.
 * @returns {Array<{type: string, name: string, latitude: number, longitude: number, expectedDateTime: Date|string|null}>}
 */
function getTravelPoints(travelPlan) {
  const points = [];

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

/**
 * Finds the closest route point that satisfies the client's trade type, radius,
 * and date window constraints.
 *
 * @param {import('sequelize').Model} alert - ClientTradeAlert model instance.
 * @param {import('sequelize').Model} travelPlan - TravelPlan model instance.
 * @returns {{point: object, distance: number}|null} Best matching route point.
 */
function findBestRoutePointForAlert(alert, travelPlan, logContext = null) {
  const travelPoints = getTravelPoints(travelPlan);
  let bestMatch = null;

  if (logContext) {
    console.log("[TRAVEL_ALERT] Checking travel plan route points", {
      ...logContext,
      routePointCount: travelPoints.length,
    });
  }

  for (const point of travelPoints) {
    const distance = getDistanceKm(
      Number(alert.latitude),
      Number(alert.longitude),
      point.latitude,
      point.longitude,
    );
    const roundedDistanceKm = Number(distance.toFixed(2));

    if (distance > Number(alert.radiusKm)) {
      if (logContext) {
        console.log("[TRAVEL_ALERT] Route point outside alert radius", {
          ...logContext,
          pointType: point.type,
          pointName: point.name,
          distanceKm: roundedDistanceKm,
          radiusKm: Number(alert.radiusKm),
        });
      }
      continue;
    }

    const dateMatched = isDateMatch(
      alert.startDate,
      alert.endDate,
      point.expectedDateTime,
    );

    if (!dateMatched) {
      if (logContext) {
        console.log("[TRAVEL_ALERT] Route point inside radius but outside date window", {
          ...logContext,
          pointType: point.type,
          pointName: point.name,
          distanceKm: roundedDistanceKm,
          expectedDateTime: point.expectedDateTime,
          alertStartDate: alert.startDate,
          alertEndDate: alert.endDate,
        });
      }
      continue;
    }

    if (logContext) {
      console.log("[TRAVEL_ALERT] Route point satisfies radius and date window", {
        ...logContext,
        pointType: point.type,
        pointName: point.name,
        distanceKm: roundedDistanceKm,
        expectedDateTime: point.expectedDateTime,
      });
    }

    if (!bestMatch || distance < bestMatch.distance) {
      bestMatch = { point, distance };
    }
  }

  return bestMatch;
}
/**
 * Returns a rough database filter for active/upcoming travel plans that can still
 * satisfy the alert window. Fine-grained matching is still done per route point.
 *
 * @param {import('sequelize').Model} alert - ClientTradeAlert model instance.
 * @param {Date} now - Current time.
 * @returns {object} Sequelize where-clause.
 */
function buildCandidateTravelPlanWhere(alert, now) {
  const earliestRelevantArrival = alert.startDate
    ? new Date(Math.max(now.getTime(), new Date(alert.startDate).getTime()))
    : now;

  const where = {
    status: { [Op.in]: ACTIVE_TRAVEL_PLAN_STATUSES },
    destinationDateTime: { [Op.gte]: earliestRelevantArrival },
  };

  if (alert.endDate) {
    where.startDateTime = { [Op.lte]: new Date(alert.endDate) };
  }

  return where;
}

/**
 * Creates a travel-plan/client-alert match, sends the user-facing notification,
 * and records the delivery status on the match row.
 *
 * @param {object} params - Match creation parameters.
 * @param {import('sequelize').Model} params.alert - Client alert that matched.
 * @param {import('sequelize').Model} params.travelPlan - Travel plan that matched.
 * @param {{point: object, distance: number}} params.bestMatch - Best matched route point.
 * @returns {Promise<import('sequelize').Model|null>} Created match or null when duplicate.
 */
async function createMatchAndNotify({ alert, travelPlan, bestMatch }) {
  const existing = await TravelPlanAlertMatch.findOne({
    where: {
      travelPlanId: travelPlan.id,
      clientTradeAlertId: alert.id,
    },
  });

  if (existing) {
    console.log("[TRAVEL_ALERT] Match already exists, skipping", {
      travelPlanId: travelPlan.id,
      clientTradeAlertId: alert.id,
      matchId: existing.id,
    });
    return null;
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

  console.log("[TRAVEL_ALERT] Match created", {
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

    console.log("[TRAVEL_ALERT] Push sent and match updated", {
      matchId: match.id,
      clientId: alert.clientId,
      sentCount: pushResult.sentCount,
      failureCount: pushResult.failureCount,
    });
  } else {
    console.log("[TRAVEL_ALERT] Push not sent, match kept pending", {
      matchId: match.id,
      clientId: alert.clientId,
      reason: pushResult.reason,
    });
  }

  return match;
}

/**
 * Matches a newly created or updated travel plan against every active client
 * trade alert. This is the existing travel-plan-first matching direction.
 *
 * @param {import('sequelize').Model} travelPlan - TravelPlan model instance.
 * @returns {Promise<{checked: number, created: number, skipped: number}>} Match summary.
 */
async function matchTravelPlanWithAlerts(travelPlan) {
  const summary = { checked: 0, created: 0, skipped: 0 };

  try {
    console.log("[TRAVEL_ALERT] Running travel-plan-to-alert matching", {
      travelPlanId: travelPlan.id,
      tradesmanId: travelPlan.tradesmanId,
    });

    const tradesman = await TradesmanDetails.findOne({
      where: { userId: travelPlan.tradesmanId },
    });

    if (!tradesman) {
      console.log("[TRAVEL_ALERT] Tradesman details not found", {
        tradesmanId: travelPlan.tradesmanId,
      });
      return summary;
    }

    const tradeTypeId = Number(tradesman.tradeTypeId);

    if (!tradeTypeId) {
      console.log("[TRAVEL_ALERT] Tradesman tradeTypeId missing", {
        tradesmanId: travelPlan.tradesmanId,
      });
      return summary;
    }

    const travelPoints = getTravelPoints(travelPlan);

    if (!travelPoints.length) {
      console.log("[TRAVEL_ALERT] No valid travel points found", {
        travelPlanId: travelPlan.id,
      });
      return summary;
    }

    const alerts = await ClientTradeAlert.findAll({
      where: {
        isActive: true,
        tradeTypeId,
      },
    });

    for (const alert of alerts) {
      summary.checked += 1;

      try {
        const bestMatch = findBestRoutePointForAlert(alert, travelPlan, {
          direction: "travel-plan-to-alert",
          travelPlanId: travelPlan.id,
          tradesmanId: travelPlan.tradesmanId,
          clientTradeAlertId: alert.id,
          clientId: alert.clientId,
        });

        if (!bestMatch) {
          console.log("[TRAVEL_ALERT] No route point matched alert", {
            direction: "travel-plan-to-alert",
            travelPlanId: travelPlan.id,
            tradesmanId: travelPlan.tradesmanId,
            clientTradeAlertId: alert.id,
            clientId: alert.clientId,
          });
          summary.skipped += 1;
          continue;
        }

        const match = await createMatchAndNotify({ alert, travelPlan, bestMatch });

        if (match) {
          summary.created += 1;
        } else {
          summary.skipped += 1;
        }
      } catch (innerError) {
        summary.skipped += 1;
        console.error("[TRAVEL_ALERT] Error while processing alert", {
          travelPlanId: travelPlan.id,
          clientTradeAlertId: alert.id,
          clientId: alert.clientId,
          error: innerError.message,
        });
      }
    }

    console.log("[TRAVEL_ALERT] Completed travel-plan-to-alert matching", {
      travelPlanId: travelPlan.id,
      tradesmanId: travelPlan.tradesmanId,
      ...summary,
    });

    return summary;
  } catch (error) {
    console.error("[TRAVEL_ALERT] Travel-plan matching error", error);
    return summary;
  }
}

/**
 * Matches a newly created, updated, or reactivated client trade alert against
 * existing valid travel plans. This is required because travel-plan-first matching
 * only runs when a tradesman creates or edits a route.
 *
 * @param {import('sequelize').Model} alert - ClientTradeAlert model instance.
 * @returns {Promise<{checked: number, created: number, skipped: number}>} Match summary.
 */
async function matchClientTradeAlertWithTravelPlans(alert) {
  const summary = { checked: 0, created: 0, skipped: 0 };

  try {
    if (!alert) {
      console.log("[TRAVEL_ALERT] Alert-to-travel-plan matching skipped: alert missing");
      return summary;
    }

    console.log("[TRAVEL_ALERT] Starting alert-to-travel-plan matching", {
      clientTradeAlertId: alert.id,
      clientId: alert.clientId,
      tradeTypeId: alert.tradeTypeId,
      radiusKm: alert.radiusKm,
      startDate: alert.startDate,
      endDate: alert.endDate,
      isActive: alert.isActive,
    });

    if (!alert.isActive) {
      console.log("[TRAVEL_ALERT] Alert-to-travel-plan matching skipped: alert inactive", {
        clientTradeAlertId: alert.id,
        clientId: alert.clientId,
      });
      return summary;
    }

    const tradeTypeId = Number(alert.tradeTypeId);

    if (!tradeTypeId) {
      console.log("[TRAVEL_ALERT] Alert-to-travel-plan matching skipped: tradeTypeId missing", {
        clientTradeAlertId: alert.id,
        clientId: alert.clientId,
        tradeTypeId: alert.tradeTypeId,
      });
      return summary;
    }

    const now = new Date();
    console.log("[TRAVEL_ALERT] Refreshing travel plan statuses before matching", {
      clientTradeAlertId: alert.id,
      now,
    });
    await refreshTravelPlanStatuses({ now });

    const candidateWhere = buildCandidateTravelPlanWhere(alert, now);
    console.log("[TRAVEL_ALERT] Searching candidate travel plans for alert", {
      clientTradeAlertId: alert.id,
      activeStatuses: ACTIVE_TRAVEL_PLAN_STATUSES,
      earliestDestinationDateTime: candidateWhere.destinationDateTime?.[Op.gte],
      latestStartDateTime: candidateWhere.startDateTime?.[Op.lte] || null,
    });

    const travelPlans = await TravelPlan.findAll({
      where: candidateWhere,
      order: [["startDateTime", "ASC"]],
    });

    console.log("[TRAVEL_ALERT] Candidate travel plans loaded", {
      clientTradeAlertId: alert.id,
      candidateTravelPlanCount: travelPlans.length,
    });

    if (!travelPlans.length) {
      await alert.update({ lastMatchedAt: now });
      console.log("[TRAVEL_ALERT] Completed alert-to-travel-plan matching: no candidates", {
        clientTradeAlertId: alert.id,
        clientId: alert.clientId,
        ...summary,
      });
      return summary;
    }

    const tradesmanIds = [...new Set(travelPlans.map((plan) => plan.tradesmanId))];
    const tradesmanDetails = await TradesmanDetails.findAll({
      where: {
        userId: { [Op.in]: tradesmanIds },
        tradeTypeId,
      },
    });
    const tradesmanDetailsByUserId = new Map(
      tradesmanDetails.map((detail) => [Number(detail.userId), detail]),
    );

    console.log("[TRAVEL_ALERT] Tradesman details filtered by alert trade type", {
      clientTradeAlertId: alert.id,
      requestedTradeTypeId: tradeTypeId,
      candidateTradesmanCount: tradesmanIds.length,
      matchingTradesmanCount: tradesmanDetails.length,
    });

    console.log("[TRAVEL_ALERT] Running alert-to-travel-plan matching", {
      clientTradeAlertId: alert.id,
      clientId: alert.clientId,
      candidateTravelPlanCount: travelPlans.length,
    });

    for (const travelPlan of travelPlans) {
      summary.checked += 1;

      try {
        console.log("[TRAVEL_ALERT] Checking candidate travel plan", {
          clientTradeAlertId: alert.id,
          clientId: alert.clientId,
          travelPlanId: travelPlan.id,
          tradesmanId: travelPlan.tradesmanId,
          status: travelPlan.status,
        });

        const tradesman = tradesmanDetailsByUserId.get(Number(travelPlan.tradesmanId));

        if (!tradesman) {
          summary.skipped += 1;
          console.log("[TRAVEL_ALERT] Travel plan skipped: tradesman trade type does not match alert", {
            clientTradeAlertId: alert.id,
            requestedTradeTypeId: tradeTypeId,
            travelPlanId: travelPlan.id,
            tradesmanId: travelPlan.tradesmanId,
          });
          continue;
        }

        const bestMatch = findBestRoutePointForAlert(alert, travelPlan, {
          direction: "alert-to-travel-plan",
          clientTradeAlertId: alert.id,
          clientId: alert.clientId,
          travelPlanId: travelPlan.id,
          tradesmanId: travelPlan.tradesmanId,
        });

        if (!bestMatch) {
          summary.skipped += 1;
          console.log("[TRAVEL_ALERT] Travel plan skipped: no route point matched radius and date window", {
            clientTradeAlertId: alert.id,
            clientId: alert.clientId,
            travelPlanId: travelPlan.id,
            tradesmanId: travelPlan.tradesmanId,
          });
          continue;
        }

        console.log("[TRAVEL_ALERT] Travel plan matched alert constraints", {
          clientTradeAlertId: alert.id,
          clientId: alert.clientId,
          travelPlanId: travelPlan.id,
          tradesmanId: travelPlan.tradesmanId,
          matchedStopName: bestMatch.point.name,
          matchedDistanceKm: Number(bestMatch.distance.toFixed(2)),
          estimatedArrivalDate: bestMatch.point.expectedDateTime,
        });

        const match = await createMatchAndNotify({ alert, travelPlan, bestMatch });

        if (match) {
          summary.created += 1;
        } else {
          summary.skipped += 1;
        }
      } catch (innerError) {
        summary.skipped += 1;
        console.error("[TRAVEL_ALERT] Error while processing travel plan", {
          travelPlanId: travelPlan.id,
          tradesmanId: travelPlan.tradesmanId,
          clientTradeAlertId: alert.id,
          error: innerError.message,
        });
      }
    }

    await alert.update({ lastMatchedAt: now });

    console.log("[TRAVEL_ALERT] Completed alert-to-travel-plan matching", {
      clientTradeAlertId: alert.id,
      clientId: alert.clientId,
      ...summary,
    });

    return summary;
  } catch (error) {
    console.error("[TRAVEL_ALERT] Alert matching error", error);
    return summary;
  }
}
module.exports = {
  getDistanceKm,
  getTravelPoints,
  isDateMatch,
  matchClientTradeAlertWithTravelPlans,
  matchTravelPlanWithAlerts,
};
