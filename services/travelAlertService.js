const { Op } = require("sequelize");
const ClientTradeAlert = require("../models/clientTradeAlertModel");
const TravelPlan = require("../models/locationModel");
const TravelPlanAlertMatch = require("../models/travelPlanAlertMatchModel");
const TradesmanDetails = require("../models/TradesmanDetails");
const User = require("../models/User");
const {
  sendPushNotification,
} = require("../controllers/notificationController");
const {
  ACTIVE_TRAVEL_PLAN_STATUSES,
  refreshTravelPlanStatuses,
} = require("./travelPlanStatusService");
const {
  sendTravelMatchCreatedEmails,
} = require("./emailService");

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
 * Parses a date-like value and returns the start of that UTC calendar day.
 *
 * Alert dates are user constraints, so matching should ignore the time portion.
 *
 * @param {Date|string|null|undefined} value - Date-like input.
 * @returns {Date|null} Start of the UTC calendar day, or null for invalid input.
 */
function startOfCalendarDay(value) {
  if (!value) return null;

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  return new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    0,
    0,
    0,
    0,
  ));
}

/**
 * Parses a date-like value and returns the end of that UTC calendar day.
 *
 * @param {Date|string|null|undefined} value - Date-like input.
 * @returns {Date|null} End of the UTC calendar day, or null for invalid input.
 */
function endOfCalendarDay(value) {
  if (!value) return null;

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  return new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    23,
    59,
    59,
    999,
  ));
}

/**
 * Converts a date-like value to a comparable UTC date key.
 *
 * @param {Date|string|null|undefined} value - Date-like input.
 * @returns {string|null} Date key in YYYY-MM-DD format.
 */
function getUtcDateKey(value) {
  const day = startOfCalendarDay(value);
  if (!day) return null;

  return day.toISOString().slice(0, 10);
}

/**
 * Checks whether the tradesman's expected arrival date falls inside the client's
 * requested alert date window.
 *
 * @param {Date|string|null} jobStartDate - Client requested start date.
 * @param {Date|string|null} jobEndDate - Client requested end date.
 * @param {Date|string|null} pointDateTime - Expected tradesman arrival date/time.
 * @returns {boolean} True when the point date satisfies the alert window.
 */
function isDateMatch(jobStartDate, jobEndDate, pointDateTime) {
  // No date filter means the client is open to any arrival time.
  if (!jobStartDate && !jobEndDate) return true;

  // If the client supplied a date constraint, an undated route point is unsafe.
  if (!pointDateTime) return false;

  const pointDateKey = getUtcDateKey(pointDateTime);

  if (!pointDateKey) return false;

  if (jobStartDate) {
    const startDateKey = getUtcDateKey(jobStartDate);
    if (!startDateKey || pointDateKey < startDateKey) return false;
  }

  if (jobEndDate) {
    const endDateKey = getUtcDateKey(jobEndDate);
    if (!endDateKey || pointDateKey > endDateKey) return false;
  }

  return true;
}


/**
 * Normalizes travel plan stops from Sequelize/MySQL into an array.
 *
 * In some environments MySQL JSON columns are returned as a JSON string,
 * while in others they are returned as an array. Matching must support both
 * forms, otherwise stops are silently skipped and only start/destination match.
 *
 * @param {Array|String|null|undefined} rawStops - Raw travelPlan.stops value.
 * @returns {Array<object>} Parsed stop objects.
 */
function normalizeTravelStops(rawStops) {
  if (!rawStops) return [];

  if (Array.isArray(rawStops)) return rawStops;

  if (typeof rawStops === "string") {
    try {
      const parsed = JSON.parse(rawStops);
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      console.warn("[TRAVEL_ALERT] Failed to parse travel plan stops JSON", {
        error: error.message,
      });
      return [];
    }
  }

  // Sequelize JSON values can sometimes be wrapped in dataValues.
  if (rawStops && Array.isArray(rawStops.dataValues)) {
    return rawStops.dataValues;
  }

  return [];
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

  const normalizedStops = normalizeTravelStops(travelPlan.stops);
  const allowStopsEnabled =
    travelPlan.allowStops === true ||
    travelPlan.allowStops === 1 ||
    travelPlan.allowStops === "1";

  if (allowStopsEnabled && normalizedStops.length > 0) {
    for (const stop of normalizedStops) {
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
      allowStops: travelPlan.allowStops,
      stopsType: Array.isArray(travelPlan.stops) ? "array" : typeof travelPlan.stops,
      normalizedStopCount: normalizeTravelStops(travelPlan.stops).length,
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
  const alertStartDay = startOfCalendarDay(alert.startDate);
  const alertEndDay = endOfCalendarDay(alert.endDate);

  const earliestRelevantArrival = alertStartDay
    ? new Date(Math.max(now.getTime(), alertStartDay.getTime()))
    : now;

  const where = {
    status: { [Op.in]: ACTIVE_TRAVEL_PLAN_STATUSES },
    destinationDateTime: { [Op.gte]: earliestRelevantArrival },
  };

  if (alertEndDay) {
    where.startDateTime = { [Op.lte]: alertEndDay };
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
      tradesmanId: travelPlan.tradesmanId,
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

  try {
    const [client, tradesmanUser] = await Promise.all([
      User.findByPk(alert.clientId),
      User.findByPk(travelPlan.tradesmanId),
    ]);

    await sendTravelMatchCreatedEmails({
      match,
      alert,
      travelPlan,
      client,
      tradesman: tradesmanUser,
    });
  } catch (emailError) {
    console.error("[TRAVEL_ALERT] Match email notification failed", {
      matchId: match.id,
      clientId: alert.clientId,
      tradesmanId: travelPlan.tradesmanId,
      error: emailError.message,
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
  normalizeTravelStops,
  isDateMatch,
  matchClientTradeAlertWithTravelPlans,
  matchTravelPlanWithAlerts,
};
