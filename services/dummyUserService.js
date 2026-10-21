const bcrypt = require("bcryptjs");
const { Op } = require("sequelize");
const sequelize = require("../config/db");
const User = require("../models/User");
const TradesmanDetails = require("../models/TradesmanDetails");
const TradesType = require("../models/tradesTypeModel");
const SubscriptionPlan = require("../models/SubscriptionPlan");
const UserSubscription = require("../models/UserSubscription");
const TravelPlan = require("../models/locationModel");
const ClientTradeAlert = require("../models/clientTradeAlertModel");
const storageService = require("./storage/storageService");
const { getStatusForTravelWindow } = require("./travelPlanStatusService");
const { buildStatePatch } = require("./verificationStateService");
const {
  matchTravelPlanWithAlerts,
  matchClientTradeAlertWithTravelPlans,
} = require("./travelAlertService");
const { escapeLike, parsePaging } = require("./adminReportQueries");
const factory = require("./dummyUserFactory");
const { DUMMY_EMAIL_DOMAIN, getDummyUsersMax, isDummyUsersEnabled } = require("../config/dummyUsers");

/** An error carrying the HTTP status the controller should answer with. */
class DummyUserError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "DummyUserError";
    this.status = status;
  }
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ROLES = ["client", "tradesman"];
const APPROVALS = ["approved", "pending"];
const SUBSCRIPTIONS = ["active", "trial", "expired", "none"];
const DEFAULT_LOCATION = { latitude: -33.8688, longitude: 151.2093, label: "Sydney NSW" };
const DAY_MS = 24 * 60 * 60 * 1000;

/* ======================= input ======================= */

const isFiniteNumber = (value) => typeof value === "number" && Number.isFinite(value);

const parseLocation = (value) => {
  if (value === undefined || value === null) return { ...DEFAULT_LOCATION };

  const latitude = Number(value.latitude);
  const longitude = Number(value.longitude);
  if (!isFiniteNumber(latitude) || latitude < -90 || latitude > 90) {
    throw new DummyUserError(400, "location.latitude must be a number between -90 and 90");
  }
  if (!isFiniteNumber(longitude) || longitude < -180 || longitude > 180) {
    throw new DummyUserError(400, "location.longitude must be a number between -180 and 180");
  }
  const label = String(value.label || DEFAULT_LOCATION.label).trim().slice(0, 100);
  return { latitude, longitude, label: label || DEFAULT_LOCATION.label };
};

/** Validates the request body and fills in defaults. Throws DummyUserError(400) for bad input. */
const parseCreateInput = (body = {}) => {
  const max = getDummyUsersMax();

  if (!ROLES.includes(body.role)) {
    throw new DummyUserError(400, "role must be 'client' or 'tradesman'");
  }

  const count = body.count === undefined ? 1 : body.count;
  if (!Number.isInteger(count) || count < 1 || count > max) {
    throw new DummyUserError(400, `count must be a whole number from 1 to ${max}`);
  }

  const input = {
    role: body.role,
    count,
    approval: body.approval === undefined ? "approved" : body.approval,
    subscription: body.subscription === undefined ? "active" : body.subscription,
    createAlert: body.createAlert === true,
    runMatching: body.runMatching !== false,
    location: parseLocation(body.location),
  };

  if (input.role === "tradesman") {
    if (!APPROVALS.includes(input.approval)) {
      throw new DummyUserError(400, `approval must be one of: ${APPROVALS.join(", ")}`);
    }
    if (!SUBSCRIPTIONS.includes(input.subscription)) {
      throw new DummyUserError(400, `subscription must be one of: ${SUBSCRIPTIONS.join(", ")}`);
    }
  }

  if (body.tradeTypeId !== undefined && body.tradeTypeId !== null && body.tradeTypeId !== "") {
    const tradeTypeId = Number(body.tradeTypeId);
    if (!Number.isInteger(tradeTypeId) || tradeTypeId <= 0) {
      throw new DummyUserError(400, "tradeTypeId must be a positive whole number");
    }
    input.tradeTypeId = tradeTypeId;
  }

  if (body.name !== undefined && body.name !== "") {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (name.length < 2 || name.length > 100) {
      throw new DummyUserError(400, "name must be 2 to 100 characters");
    }
    input.name = name;
  }

  if (body.email !== undefined && body.email !== "") {
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!EMAIL_PATTERN.test(email) || email.length > 190) {
      throw new DummyUserError(400, "A valid email is required");
    }
    input.email = email;
  }

  if ((input.name || input.email) && count !== 1) {
    throw new DummyUserError(400, "A name or email can only be set when creating one test user");
  }

  if (body.password !== undefined && body.password !== "") {
    if (typeof body.password !== "string" || body.password.length < 8 || body.password.length > 72) {
      throw new DummyUserError(400, "password must be 8 to 72 characters");
    }
    input.password = body.password;
  }

  return input;
};

/* ======================= creation ======================= */

const countDummyUsers = () => User.count({ where: { isDummy: true } });

/**
 * needsReview: the test user must wait for an admin ("pending"). Only trades that need a licence ever reach
 * the review queue (everyone else is approved automatically), so only those make sense then.
 */
const pickTradeType = async (tradeTypeId, { needsReview = false } = {}) => {
  if (tradeTypeId) {
    const trade = await TradesType.findOne({ where: { id: tradeTypeId, isActive: true } });
    if (!trade) throw new DummyUserError(400, "Invalid tradeTypeId");
    if (needsReview && !trade.licenceRequired) {
      throw new DummyUserError(
        400,
        `${trade.name} does not need a licence, so nobody reviews it. Pick a trade that needs a licence, or create the test user as approved.`,
      );
    }
    return trade;
  }

  const trades = await TradesType.findAll({
    where: { isActive: true, ...(needsReview ? { licenceRequired: true } : {}) },
  });
  if (!trades.length) {
    throw new DummyUserError(
      400,
      needsReview
        ? "No active trade needs a licence yet, so there is nothing for an admin to review. Turn on a licence requirement on the Trades page, or create the test user as approved."
        : "There are no active trade types yet. Add one on the Trades page first.",
    );
  }
  return trades[Math.floor(Math.random() * trades.length)];
};

const findPlan = async () => {
  const plan =
    (await SubscriptionPlan.findOne({ where: { isDefault: true }, order: [["id", "ASC"]] })) ||
    (await SubscriptionPlan.findOne({ order: [["id", "ASC"]] }));
  if (!plan) {
    throw new DummyUserError(400, "There is no subscription plan yet, so a subscription cannot be added.");
  }
  return plan;
};

/** A unique `.test` address for a generated test user. */
const uniqueGeneratedEmail = async (name) => {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const email = factory.generateEmail(name);
    if (!(await User.findOne({ where: { email }, attributes: ["id"] }))) return email;
  }
  throw new DummyUserError(500, "Could not generate a unique email address. Please try again.");
};

const buildSubscriptionRow = (userId, plan, kind, now) => {
  if (kind === "none") return null;

  const base = { userId, planId: plan.id, startDate: now, stripeSubscriptionId: null };
  if (kind === "active") {
    return { ...base, status: "active", currentPeriodStart: now, currentPeriodEnd: new Date(now.getTime() + 365 * DAY_MS) };
  }
  if (kind === "trial") {
    const end = new Date(now.getTime() + 14 * DAY_MS);
    return { ...base, status: "trialing", trialEndsAt: end, currentPeriodStart: now, currentPeriodEnd: end };
  }
  // "expired": ended well past the grace period, so it grants no access.
  return {
    ...base,
    status: "canceled",
    startDate: new Date(now.getTime() - 40 * DAY_MS),
    currentPeriodStart: new Date(now.getTime() - 40 * DAY_MS),
    currentPeriodEnd: new Date(now.getTime() - 10 * DAY_MS),
  };
};

const saveImages = async (savedFiles, { withLicence }) => {
  const save = async (label, color, category) => {
    const key = await storageService.saveSingleImage({
      file: await factory.buildPlaceholderImage(label, color),
      category,
    });
    savedFiles.push({ key, category });
    return key;
  };

  return {
    profileImage: await save("PROFILE", "#3b2e1e", "profile"),
    licenseDocument: withLicence ? await save("LICENCE", "#7a5c2e", "license") : null,
    portfolioPhotos: [
      await save("PORTFOLIO 1", "#2f6f8f", "portfolio"),
      await save("PORTFOLIO 2", "#3f8f5f", "portfolio"),
    ],
  };
};

/**
 * Creates `input.count` test users in one transaction (all or nothing; files are removed if anything fails).
 * Returns the created users WITH their plain-text passwords: the only time they are ever visible.
 */
const createDummyUsers = async ({ adminId, input }) => {
  const max = getDummyUsersMax();
  const existing = await countDummyUsers();
  if (existing + input.count > max) {
    throw new DummyUserError(
      409,
      `You can have at most ${max} test users at once (${existing} exist now). Delete some first.`,
    );
  }

  if (input.email && (await User.findOne({ where: { email: input.email }, attributes: ["id"] }))) {
    throw new DummyUserError(409, "A user with this email already exists");
  }

  const isTradesman = input.role === "tradesman";
  const now = new Date();
  const needsReview = isTradesman && input.approval === "pending";
  const trade = isTradesman || input.createAlert ? await pickTradeType(input.tradeTypeId, { needsReview }) : null;
  const licenceRequired = Boolean(trade && trade.licenceRequired);
  const plan = isTradesman && input.subscription !== "none" ? await findPlan() : null;

  const savedFiles = [];
  const created = [];
  const matchTargets = [];

  try {
    await sequelize.transaction(async (transaction) => {
      for (let index = 0; index < input.count; index += 1) {
        const name = input.name || factory.generateName();
        const email = input.email || (await uniqueGeneratedEmail(name));
        const password = input.password || factory.generatePassword();
        const images = isTradesman ? await saveImages(savedFiles, { withLicence: licenceRequired }) : null;
        // Same state rules as a real account: only a licence-required trade can be "licence verified".
        const verification = isTradesman
          ? buildStatePatch(input.approval === "approved" ? "approved" : "pending", {
              adminId,
              licenceVerified: licenceRequired && input.approval === "approved",
              now,
            })
          : null;

        const user = await User.create(
          {
            name,
            email,
            mobile: factory.generateMobile(),
            password: await bcrypt.hash(password, 10),
            role: input.role,
            provider: "manual",
            isDummy: true,
            isVerified: isTradesman ? verification.user.isVerified : true,
            profileImage: images ? images.profileImage : null,
          },
          { transaction },
        );

        const summary = { id: user.id, role: user.role, name, email, password };

        if (isTradesman) {
          const profile = factory.generateTradesmanProfile(name, trade.name);
          await TradesmanDetails.create(
            {
              userId: user.id,
              tradeType: trade.name,
              tradeTypeId: trade.id,
              ...profile,
              licenseNumber: licenceRequired ? profile.licenseNumber : null,
              currentLocation: `${input.location.latitude},${input.location.longitude}`,
              licenseExpiry: licenceRequired ? new Date(now.getTime() + 2 * 365 * DAY_MS) : null,
              licenseDocument: images.licenseDocument,
              portfolioPhotos: images.portfolioPhotos,
              ...verification.details,
              submittedAt: now,
            },
            { transaction },
          );

          const subscriptionRow = buildSubscriptionRow(user.id, plan, input.subscription, now);
          if (subscriptionRow) await UserSubscription.create(subscriptionRow, { transaction });

          // A running trip starting now, so the tradesman shows up in nearby searches straight away.
          const start = now;
          const end = new Date(now.getTime() + 14 * DAY_MS);
          const travelPlan = await TravelPlan.create(
            {
              tradesmanId: user.id,
              currentLocation: `${input.location.latitude},${input.location.longitude}`,
              latitude: input.location.latitude,
              longitude: input.location.longitude,
              startLocation: input.location.label,
              startDateTime: start,
              destination: `${input.location.label} (test destination)`,
              destinationLatitude: input.location.latitude + 0.2,
              destinationLongitude: input.location.longitude + 0.2,
              destinationDateTime: end,
              allowStops: false,
              status: getStatusForTravelWindow(start, end, now),
            },
            { transaction },
          );

          Object.assign(summary, {
            trade: trade.name,
            businessName: profile.businessName,
            approval: input.approval,
            subscription: input.subscription,
            location: input.location.label,
          });
          matchTargets.push({ kind: "plan", record: travelPlan });
        } else if (input.createAlert) {
          const alert = await ClientTradeAlert.create(
            {
              clientId: user.id,
              tradeType: trade.name,
              tradeTypeId: trade.id,
              locationName: input.location.label,
              latitude: input.location.latitude,
              longitude: input.location.longitude,
              radiusKm: 25,
              isActive: true,
            },
            { transaction },
          );
          Object.assign(summary, { alertTrade: trade.name, location: input.location.label });
          matchTargets.push({ kind: "alert", record: alert });
        }

        created.push(summary);
      }
    });
  } catch (error) {
    // Nothing was kept, so remove every uploaded file as well.
    await Promise.all(
      savedFiles.map(({ key, category }) => storageService.deleteObject(key, { category }).catch(() => {})),
    );
    if (error?.name === "SequelizeUniqueConstraintError") {
      throw new DummyUserError(409, "A user with this email already exists");
    }
    throw error;
  }

  // Like real users, new plans/alerts are matched against each other (test users only match test users).
  // Best effort: a matching problem must never undo the creation.
  if (input.runMatching) {
    for (const target of matchTargets) {
      try {
        if (target.kind === "plan") await matchTravelPlanWithAlerts(target.record);
        else await matchClientTradeAlertWithTravelPlans(target.record);
      } catch (error) {
        console.error("[DUMMY_USERS] matching failed:", error.message);
      }
    }
  }

  return { created, remaining: max - existing - created.length };
};

/* ======================= listing and status ======================= */

const getStatus = async () => {
  const max = getDummyUsersMax();
  const count = await countDummyUsers();
  return {
    enabled: isDummyUsersEnabled(),
    max,
    count,
    remaining: Math.max(max - count, 0),
    emailDomain: DUMMY_EMAIL_DOMAIN,
  };
};

const listDummyUsers = async (query = {}) => {
  const paging = parsePaging({ page: query.page, limit: query.limit || 50 });
  const where = { isDummy: true };

  if (query.role) {
    if (!ROLES.includes(query.role)) throw new DummyUserError(400, "role must be 'client' or 'tradesman'");
    where.role = query.role;
  }

  const search = String(query.search || "").trim().slice(0, 100);
  if (search) {
    const like = { [Op.like]: `%${escapeLike(search)}%` };
    where[Op.or] = [{ name: like }, { email: like }];
  }

  const { count, rows } = await User.findAndCountAll({
    where,
    attributes: ["id", "name", "email", "mobile", "role", "isVerified", "createdAt"],
    order: [["createdAt", "DESC"], ["id", "DESC"]],
    limit: paging.limit,
    offset: paging.offset,
  });

  const ids = rows.map((row) => row.id);
  const [details, subscriptions, plans] = ids.length
    ? await Promise.all([
        TradesmanDetails.findAll({ where: { userId: ids } }),
        UserSubscription.findAll({ where: { userId: ids }, order: [["id", "DESC"]] }),
        TravelPlan.findAll({ where: { tradesmanId: ids }, attributes: ["tradesmanId", "status"] }),
      ])
    : [[], [], []];

  const detailsByUser = new Map(details.map((item) => [item.userId, item]));
  const subscriptionByUser = new Map();
  subscriptions.forEach((item) => {
    if (!subscriptionByUser.has(item.userId)) subscriptionByUser.set(item.userId, item); // newest first
  });
  const planCountByUser = new Map();
  plans.forEach((item) => planCountByUser.set(item.tradesmanId, (planCountByUser.get(item.tradesmanId) || 0) + 1));

  const data = rows.map((row) => {
    const detail = detailsByUser.get(row.id);
    const subscription = subscriptionByUser.get(row.id);
    return {
      id: row.id,
      name: row.name,
      email: row.email,
      mobile: row.mobile,
      role: row.role,
      isVerified: row.isVerified,
      createdAt: row.createdAt,
      tradesman: detail
        ? {
            tradeType: detail.tradeType,
            businessName: detail.businessName,
            verificationStatus: detail.verificationStatus,
            isApproved: detail.isApproved,
            travelPlans: planCountByUser.get(row.id) || 0,
          }
        : null,
      subscription: subscription
        ? { status: subscription.status, currentPeriodEnd: subscription.currentPeriodEnd }
        : null,
    };
  });

  return { data, meta: { total: count, page: paging.page, perPage: paging.limit, ...(await getStatus()) } };
};

/** Sets a new password for a TEST user only (never a real user) and returns it once. */
const resetDummyPassword = async ({ id, password }) => {
  const user = await User.findOne({ where: { id, isDummy: true } });
  if (!user) throw new DummyUserError(404, "Test user not found");

  if (password !== undefined && password !== "" && (typeof password !== "string" || password.length < 8 || password.length > 72)) {
    throw new DummyUserError(400, "password must be 8 to 72 characters");
  }

  const newPassword = password || factory.generatePassword();
  await user.update({
    password: await bcrypt.hash(newPassword, 10),
    resetPasswordToken: null,
    resetPasswordExpires: null,
  });
  return { id: user.id, email: user.email, password: newPassword };
};

module.exports = {
  DummyUserError,
  parseCreateInput,
  createDummyUsers,
  getStatus,
  listDummyUsers,
  resetDummyPassword,
};
