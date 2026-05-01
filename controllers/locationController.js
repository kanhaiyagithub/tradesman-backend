const TravelPlan = require("../models/locationModel");

const User = require("../models/User");

const SubscriptionPlan = require("../models/SubscriptionPlan");

const UserSubscription = require("../models/UserSubscription");

const Review = require("../models/reviewModel");

const { Op, fn, col } = require("sequelize");
const storageService = require("../services/storage/storageService");

const { matchTravelPlanWithAlerts } = require("../services/travelAlertService");

// ================= RESPONSE HELPER =================

const sendResponse = (res, statusCode, success, message, data = null) =>
  res.status(statusCode).json({ success, message, data });

// ================= SUBSCRIPTION HELPER =================

async function getAccessiblePlanForUser(userId) {
  return await UserSubscription.findOne({
    where: {
      userId,

      status: {
        [Op.in]: ["active", "trialing"],
      },
    },

    include: [{ model: SubscriptionPlan, as: "plan" }],

    order: [["createdAt", "DESC"]],
  });
}

// ================= STOPS PARSER =================

function parseStops(stops) {
  if (!stops) return null;

  let arr = stops;

  if (typeof stops === "string") {
    try {
      arr = JSON.parse(stops);
    } catch (error) {
      arr = stops

        .split(",")

        .map((s) => s.trim())

        .filter(Boolean);
    }
  }

  if (!Array.isArray(arr) || !arr.length) return null;

  const normalizedStops = arr

    .map((stop) => {
      if (typeof stop === "string") {
        return {
          name: stop.trim(),

          latitude: null,

          longitude: null,

          expectedDateTime: null,
        };
      }

      if (typeof stop === "object" && stop !== null) {
        const name = stop.name ? String(stop.name).trim() : "";

        const latitude =
          stop.latitude !== undefined &&
          stop.latitude !== null &&
          stop.latitude !== ""
            ? Number(stop.latitude)
            : null;

        const longitude =
          stop.longitude !== undefined &&
          stop.longitude !== null &&
          stop.longitude !== ""
            ? Number(stop.longitude)
            : null;

        return {
          name,

          latitude: Number.isNaN(latitude) ? null : latitude,

          longitude: Number.isNaN(longitude) ? null : longitude,

          expectedDateTime: stop.expectedDateTime || null,
        };
      }

      return null;
    })

    .filter((stop) => stop && stop.name);

  return normalizedStops.length ? normalizedStops : null;
}

function validateStopsStructure(parsedStops) {
  if (!parsedStops || !parsedStops.length) {
    return "Valid stops are required when allowStops is true";
  }

  const invalidStop = parsedStops.find(
    (stop) =>
      stop.latitude === null ||
      stop.longitude === null ||
      Number.isNaN(Number(stop.latitude)) ||
      Number.isNaN(Number(stop.longitude)),
  );

  if (invalidStop) {
    return "Each stop must include valid name, latitude and longitude";
  }

  const invalidTime = parsedStops.find(
    (stop) =>
      stop.expectedDateTime &&
      Number.isNaN(new Date(stop.expectedDateTime).getTime()),
  );

  if (invalidTime) {
    return "Invalid expectedDateTime format in stops";
  }

  return null;
}

function enforcePlanStopLimit(subscription, allowStops, parsedStops) {
  if (!allowStops) return null;

  const maxStops = subscription?.plan?.maxSharedLocations ?? 0;

  const stopCount = parsedStops?.length || 0;

  if (stopCount > maxStops) {
    return `Your current plan allows maximum ${maxStops} stop(s).`;
  }

  return null;
}

exports.createTravelPlan = async (req, res) => {
  try {
    const { id: userId, role } = req.user;

    if (role !== "tradesman") {
      return sendResponse(res, 403, false, "Only tradesmen can create plans");
    }

    const subscription = await getAccessiblePlanForUser(userId);

    if (!subscription || !subscription.plan) {
      return sendResponse(
        res,

        403,

        false,

        "An active or trialing subscription is required to create a travel plan",
      );
    }

    const {
      currentLocation,

      latitude,

      longitude,

      startLocation,

      startDateTime,

      destination,

      destinationLatitude,

      destinationLongitude,

      destinationDateTime,

      priceRange,

      allowStops,

      stops,
    } = req.body;

    if (
      !startLocation ||
      !destination ||
      !startDateTime ||
      !destinationDateTime ||
      latitude === undefined ||
      longitude === undefined ||
      destinationLatitude === undefined ||
      destinationLongitude === undefined
    ) {
      return sendResponse(res, 400, false, "All required fields missing");
    }

    if (
      Number.isNaN(Number(latitude)) ||
      Number.isNaN(Number(longitude)) ||
      Number.isNaN(Number(destinationLatitude)) ||
      Number.isNaN(Number(destinationLongitude))
    ) {
      return sendResponse(
        res,

        400,

        false,

        "Latitude and longitude values must be valid numbers",
      );
    }

    if (
      Number.isNaN(new Date(startDateTime).getTime()) ||
      Number.isNaN(new Date(destinationDateTime).getTime())
    ) {
      return sendResponse(
        res,

        400,

        false,

        "Invalid startDateTime or destinationDateTime format",
      );
    }

    if (new Date(destinationDateTime) < new Date(startDateTime)) {
      return sendResponse(
        res,

        400,

        false,

        "destinationDateTime cannot be before startDateTime",
      );
    }

    const parsedStops = parseStops(stops);

    if (allowStops === true) {
      const structureError = validateStopsStructure(parsedStops);

      if (structureError) {
        return sendResponse(res, 400, false, structureError);
      }

      const limitError = enforcePlanStopLimit(
        subscription,

        allowStops,

        parsedStops,
      );

      if (limitError) {
        return sendResponse(res, 400, false, limitError);
      }
    }

    const overlapPlan = await TravelPlan.findOne({
      where: {
        tradesmanId: userId,

        status: "open",

        startDateTime: { [Op.lte]: destinationDateTime },

        destinationDateTime: { [Op.gte]: startDateTime },
      },
    });

    if (overlapPlan) {
      return sendResponse(res, 400, false, "Active travel plan already exists");
    }

    const plan = await TravelPlan.create({
      tradesmanId: userId,

      currentLocation,

      latitude,

      longitude,

      startLocation,

      startDateTime,

      destination,

      destinationLatitude,

      destinationLongitude,

      destinationDateTime,

      priceRange,

      allowStops,

      stops: allowStops ? parsedStops : null,

      status: "open",
    });

    await matchTravelPlanWithAlerts(plan);

    return sendResponse(res, 201, true, "Travel plan created", plan);
  } catch (err) {
    console.error(err);

    return sendResponse(res, 500, false, "Server error");
  }
};

exports.getMyTravelPlans = async (req, res) => {
  try {
    const plans = await TravelPlan.findAll({
      where: { tradesmanId: req.user.id },

      order: [["createdAt", "DESC"]],
    });

    return sendResponse(res, 200, true, "My plans", plans);
  } catch (err) {
    return sendResponse(res, 500, false, "Server error");
  }
};

exports.updateMyTravelPlan = async (req, res) => {
  try {
    const { id: userId, role } = req.user;

    if (role !== "tradesman") {
      return sendResponse(res, 403, false, "Only tradesmen allowed");
    }

    const subscription = await getAccessiblePlanForUser(userId);

    if (!subscription || !subscription.plan) {
      return sendResponse(
        res,

        403,

        false,

        "An active or trialing subscription is required to update a travel plan",
      );
    }

    const plan = await TravelPlan.findOne({
      where: {
        tradesmanId: userId,

        status: "open",

        destinationDateTime: { [Op.gte]: new Date() },
      },
    });

    if (!plan) {
      return sendResponse(res, 404, false, "No active travel plan found");
    }

    const {
      currentLocation,

      latitude,

      longitude,

      startLocation,

      startDateTime,

      destination,

      destinationLatitude,

      destinationLongitude,

      destinationDateTime,

      priceRange,

      allowStops,

      stops,

      status,
    } = req.body;

    if (currentLocation !== undefined) plan.currentLocation = currentLocation;

    if (latitude !== undefined) plan.latitude = latitude;

    if (longitude !== undefined) plan.longitude = longitude;

    if (startLocation !== undefined) plan.startLocation = startLocation;

    if (destination !== undefined) plan.destination = destination;

    if (priceRange !== undefined) plan.priceRange = priceRange;

    if (status !== undefined) plan.status = status;

    if (startDateTime !== undefined) plan.startDateTime = startDateTime;

    if (destinationDateTime !== undefined) {
      plan.destinationDateTime = destinationDateTime;
    }

    if (destinationLatitude !== undefined) {
      plan.destinationLatitude = destinationLatitude;
    }

    if (destinationLongitude !== undefined) {
      plan.destinationLongitude = destinationLongitude;
    }

    const nextAllowStops =
      allowStops !== undefined ? allowStops : Boolean(plan.allowStops);

    let nextStops = plan.stops;

    if (allowStops !== undefined) {
      plan.allowStops = allowStops;

      if (allowStops === true) {
        const parsedStops = parseStops(stops);

        const structureError = validateStopsStructure(parsedStops);

        if (structureError) {
          return sendResponse(res, 400, false, structureError);
        }

        const limitError = enforcePlanStopLimit(
          subscription,

          allowStops,

          parsedStops,
        );

        if (limitError) {
          return sendResponse(res, 400, false, limitError);
        }

        nextStops = parsedStops;

        plan.stops = parsedStops;
      } else {
        nextStops = null;

        plan.stops = null;
      }
    } else if (stops !== undefined) {
      if (plan.allowStops) {
        const parsedStops = parseStops(stops);

        const structureError = validateStopsStructure(parsedStops);

        if (structureError) {
          return sendResponse(res, 400, false, structureError);
        }

        const limitError = enforcePlanStopLimit(
          subscription,

          true,

          parsedStops,
        );

        if (limitError) {
          return sendResponse(res, 400, false, limitError);
        }

        nextStops = parsedStops;

        plan.stops = parsedStops;
      }
    }

    if (nextAllowStops === true) {
      const currentStops = nextStops || [];

      const limitError = enforcePlanStopLimit(subscription, true, currentStops);

      if (limitError) {
        return sendResponse(res, 400, false, limitError);
      }
    }

    if (
      startDateTime !== undefined &&
      Number.isNaN(new Date(startDateTime).getTime())
    ) {
      return sendResponse(res, 400, false, "Invalid startDateTime format");
    }

    if (
      destinationDateTime !== undefined &&
      Number.isNaN(new Date(destinationDateTime).getTime())
    ) {
      return sendResponse(
        res,

        400,

        false,

        "Invalid destinationDateTime format",
      );
    }

    const nextStartDateTime =
      startDateTime !== undefined
        ? new Date(startDateTime)
        : new Date(plan.startDateTime);

    const nextDestinationDateTime =
      destinationDateTime !== undefined
        ? new Date(destinationDateTime)
        : new Date(plan.destinationDateTime);

    if (nextDestinationDateTime < nextStartDateTime) {
      return sendResponse(
        res,

        400,

        false,

        "destinationDateTime cannot be before startDateTime",
      );
    }

    await plan.save();

    await matchTravelPlanWithAlerts(plan);

    return sendResponse(res, 200, true, "Travel plan updated", plan);
  } catch (err) {
    console.error(err);

    return sendResponse(res, 500, false, "Server error");
  }
};

exports.deleteTravelPlan = async (req, res) => {
  try {
    const plan = await TravelPlan.findByPk(req.params.id);

    if (!plan) return sendResponse(res, 404, false, "Plan not found");

    if (plan.tradesmanId !== req.user.id) {
      return sendResponse(res, 403, false, "Not allowed");
    }

    await plan.destroy();

    return sendResponse(res, 200, true, "Deleted");
  } catch (err) {
    return sendResponse(res, 500, false, "Server error");
  }
};

exports.getTradesmanProfile = async (req, res) => {
  try {
    const { tradesmanId } = req.params;

    const tradesman = await User.findOne({
      where: { id: tradesmanId, role: "tradesman" },

      attributes: ["id", "name", "profileImage"],
    });

    if (!tradesman) {
      return sendResponse(res, 404, false, "Tradesman not found");
    }

    const travelPlan = await TravelPlan.findOne({
      where: {
        tradesmanId,

        status: "open",

        destinationDateTime: { [Op.gte]: new Date() },
      },

      order: [["startDateTime", "ASC"]],
    });

    const ratingAgg = await Review.findOne({
      where: { toUserId: tradesmanId },

      attributes: [
        [fn("AVG", col("rating")), "avgRating"],

        [fn("COUNT", col("id")), "reviewCount"],
      ],

      raw: true,
    });

    const response = {
      id: tradesman.id,

      name: tradesman.name,

      profileImage: storageService.toPublicUrl(tradesman.profileImage, {
        category: "profile",
      }),

      rating: ratingAgg?.avgRating
        ? Number(ratingAgg.avgRating).toFixed(1)
        : "0.0",

      reviewCount: ratingAgg?.reviewCount || 0,

      location: travelPlan
        ? {
            current: travelPlan.currentLocation,

            start: travelPlan.startLocation,

            destination: travelPlan.destination,

            stops: travelPlan.allowStops ? travelPlan.stops : [],

            startDateTime: travelPlan.startDateTime,

            destinationDateTime: travelPlan.destinationDateTime,

            status:
              new Date() < new Date(travelPlan.startDateTime)
                ? "Upcoming"
                : "Active",
          }
        : null,

      availability: travelPlan ? "Available" : "Not Available",

      priceRange: travelPlan?.priceRange || null,
    };

    return sendResponse(res, 200, true, "Profile fetched", response);
  } catch (err) {
    console.error(err);

    return sendResponse(res, 500, false, "Server error");
  }
};
