const { Op } = require("sequelize");

const MetaConversionEvent = require("../models/MetaConversionEvent");
const MetaUserAttribution = require("../models/MetaUserAttribution");
const User = require("../models/User");
const UserSubscription = require("../models/UserSubscription");
const SubscriptionPlan = require("../models/SubscriptionPlan");
const {
  sanitizeAttribution,
  sanitizeRequestContext,
  toMajorUnits,
  buildEvent,
  hasIdentifiers,
} = require("../utils/metaCapi");

/**
 * Meta Conversions API (app events) service.
 *
 * Every public track* function catches its own errors and never throws, so a
 * Meta problem can never break signup, login or the Stripe webhook.
 */

const DEFAULT_DATASET_ID = "1813699159758304";
const MAX_TOTAL_ATTEMPTS = 8;
const ATTEMPTS_PER_DISPATCH = 3;
const PENDING_RETRY_AFTER_MS = 5 * 60 * 1000;
const RETRY_WINDOW_MS = 6 * 24 * 60 * 60 * 1000;
const RETRY_BATCH_SIZE = 200;

let retryDelaysMs = [1000, 3000];
let warnedMissingToken = false;

// Background sends in flight; lets tests (and shutdown code) wait for them.
const inflight = new Set();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Reads configuration on every call so env changes apply without a restart. */
const getConfig = () => ({
  enabled: process.env.META_CAPI_ENABLED === "true",
  appId: process.env.META_APP_ID || "",
  datasetId: process.env.META_DATASET_ID || DEFAULT_DATASET_ID,
  accessToken: process.env.META_CAPI_ACCESS_TOKEN || "",
  testEventCode: process.env.META_TEST_EVENT_CODE || "",
  apiVersion: process.env.META_GRAPH_API_VERSION || "v23.0",
  defaultPhoneCountryCode: process.env.META_DEFAULT_PHONE_COUNTRY_CODE || "61",
  defaultTrackingEnabled: process.env.META_DEFAULT_TRACKING_ENABLED !== "false",
  timeoutMs: Number(process.env.META_CAPI_TIMEOUT_MS) || 8000,
});

/** True only when tracking is switched on AND fully configured. */
const isReady = (config) => {
  if (!config.enabled) return false;

  if (!config.accessToken || !config.datasetId) {
    if (!warnedMissingToken) {
      warnedMissingToken = true;
      console.warn(
        "[META_CAPI] META_CAPI_ENABLED=true but META_CAPI_ACCESS_TOKEN or META_DATASET_ID is missing; tracking is disabled."
      );
    }
    return false;
  }

  return true;
};

const redact = (message, config) => {
  let text = String(message || "");
  if (config && config.accessToken) text = text.split(config.accessToken).join("[redacted]");
  return text.slice(0, 1000);
};

const logError = (label, error) => {
  console.error(`[META_CAPI] ${label}:`, redact(error && error.message ? error.message : error, getConfig()));
};

/**
 * POSTs events to the Conversions API. The access token travels in the JSON
 * body, never in the URL. Resolves with { ok, transient, error, fbtraceId }.
 */
const postEvents = async (config, events, testEventCode = config.testEventCode) => {
  const url = `https://graph.facebook.com/${config.apiVersion}/${config.datasetId}/events`;
  const body = { data: events, access_token: config.accessToken };
  if (testEventCode) body.test_event_code = testEventCode;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  let response;
  let json = {};

  try {
    response = await globalThis.fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    try {
      json = (await response.json()) || {};
    } catch (error) {
      json = {};
    }
  } catch (error) {
    const reason = error && error.name === "AbortError" ? "timeout" : error && error.message;
    return { ok: false, transient: true, error: redact(`network_error: ${reason}`, config) };
  } finally {
    clearTimeout(timer);
  }

  const fbtraceId = json.fbtrace_id || (json.error && json.error.fbtrace_id) || null;

  if (response.ok && Number(json.events_received) >= 1) {
    return { ok: true, status: response.status, fbtraceId };
  }

  if (response.ok) {
    return {
      ok: false,
      transient: false,
      fbtraceId,
      error: `events_received=${json.events_received ?? 0}`,
    };
  }

  const detail = (json.error && json.error.message) || "unknown error";
  return {
    ok: false,
    transient: response.status === 429 || response.status >= 500,
    fbtraceId,
    error: redact(`HTTP ${response.status}: ${detail}`, config),
  };
};

/**
 * Sends one stored event, retrying transient failures, then records the outcome.
 */
const dispatchEvent = async (row, config, { maxAttempts = ATTEMPTS_PER_DISPATCH } = {}) => {
  const event = typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
  const testEventCode = row.isTest ? config.testEventCode : "";
  let attempts = Number(row.attempts) || 0;
  let result = { ok: false, transient: false, error: "not_attempted" };

  for (let index = 0; index < maxAttempts; index += 1) {
    if (index > 0) await sleep(retryDelaysMs[index - 1] ?? retryDelaysMs[retryDelaysMs.length - 1] ?? 0);

    attempts += 1;
    result = await postEvents(config, [event], testEventCode);
    if (result.ok || !result.transient) break;
  }

  const update = result.ok
    ? { status: "sent", attempts, lastError: null, fbtraceId: result.fbtraceId, sentAt: new Date() }
    : {
        status: "failed",
        attempts,
        lastError: result.error,
        ...(result.fbtraceId ? { fbtraceId: result.fbtraceId } : {}),
      };

  await MetaConversionEvent.update(update, { where: { id: row.id } });
  return { ok: result.ok, attempts };
};

const dispatchInBackground = (row, config, options) => {
  const task = Promise.resolve()
    .then(() => dispatchEvent(row, config, options))
    .catch((error) => logError("dispatch failed", error))
    .finally(() => inflight.delete(task));

  inflight.add(task);
  return task;
};

/** Resolves once every background send started so far has finished. */
const flush = async () => {
  while (inflight.size) {
    await Promise.all([...inflight]);
  }
};

/**
 * Writes the event row BEFORE calling Meta, then sends in the background.
 * A duplicate eventId (unique column) is ignored.
 */
const recordAndSend = async ({ event, userId, config }) => {
  const identifiable = hasIdentifiers(event);

  let row;
  try {
    row = await MetaConversionEvent.create({
      eventId: event.event_id,
      eventName: event.event_name,
      userId: userId || null,
      status: identifiable ? "pending" : "skipped",
      attempts: 0,
      isTest: Boolean(config.testEventCode),
      payload: identifiable ? event : null,
      lastError: identifiable ? null : "no_identifiers",
    });
  } catch (error) {
    if (error && error.name === "SequelizeUniqueConstraintError") {
      return { tracked: false, reason: "duplicate" };
    }
    throw error;
  }

  if (!identifiable) return { tracked: false, reason: "skipped" };

  dispatchInBackground(row, config);
  return { tracked: true, eventId: event.event_id };
};

const toPlain = (row) => (row && typeof row.get === "function" ? row.get({ plain: true }) : row);

/**
 * Upserts the user's attribution row. Only valid, non-empty values are written,
 * so known values are never overwritten by empty ones. Returns the merged row.
 */
const saveAttribution = async (userId, rawAttribution, { ip, userAgent } = {}) => {
  const fields = {
    ...(sanitizeAttribution(rawAttribution) || {}),
    ...sanitizeRequestContext({ ip, userAgent }),
  };

  const existing = await MetaUserAttribution.findOne({ where: { userId } });

  if (existing) {
    if (Object.keys(fields).length) {
      await MetaUserAttribution.update(fields, { where: { userId } });
    }
    return { ...toPlain(existing), ...fields };
  }

  try {
    await MetaUserAttribution.create({ userId, ...fields });
  } catch (error) {
    if (!error || error.name !== "SequelizeUniqueConstraintError") throw error;
    // A concurrent request created the row first; update it instead.
    if (Object.keys(fields).length) {
      await MetaUserAttribution.update(fields, { where: { userId } });
    }
  }

  return { userId, ...fields };
};

/** Saves attribution without ever throwing. Returns true when it was saved. */
const trackAttributionOnly = async ({ userId, metaAttribution, ip, userAgent }) => {
  try {
    if (!isReady(getConfig()) || !userId) return false;
    await saveAttribution(userId, metaAttribution, { ip, userAgent });
    return true;
  } catch (error) {
    logError("saving attribution failed", error);
    return false;
  }
};

/**
 * CompleteRegistration for a newly created user. Never throws.
 *
 * @param {object} params
 * @param {object} params.user - Created user (id, email, mobile, role).
 * @param {"email"|"google"} params.method
 * @param {object|string} [params.metaAttribution] - Untrusted app payload.
 * @param {string} [params.ip]
 * @param {string} [params.userAgent]
 */
const trackRegistration = async ({ user, method, metaAttribution, ip, userAgent }) => {
  try {
    const config = getConfig();
    if (!isReady(config)) return { tracked: false, reason: "disabled" };
    if (!user || !user.id) return { tracked: false, reason: "no_user" };
    if (user.role === "admin") return { tracked: false, reason: "admin" };

    let attribution;
    try {
      attribution = await saveAttribution(user.id, metaAttribution, { ip, userAgent });
    } catch (error) {
      logError("saving attribution failed", error);
      attribution = {
        ...(sanitizeAttribution(metaAttribution) || {}),
        ...sanitizeRequestContext({ ip, userAgent }),
      };
    }

    const event = buildEvent({
      eventName: "CompleteRegistration",
      eventTime: Math.floor(Date.now() / 1000),
      eventId: `registration_${user.id}`,
      email: user.email,
      phone: user.mobile,
      userId: user.id,
      attribution,
      customData: {
        registration_method: method,
        user_role: user.role,
        status: true,
      },
      defaultTrackingEnabled: config.defaultTrackingEnabled,
      defaultPhoneCountryCode: config.defaultPhoneCountryCode,
    });

    return await recordAndSend({ event, userId: user.id, config });
  } catch (error) {
    logError("trackRegistration failed", error);
    return { tracked: false, reason: "error" };
  }
};

const idOf = (value) => (value && typeof value === "object" ? value.id : value) || null;

const getInvoiceSubscriptionId = (invoice) =>
  idOf(invoice.subscription) ||
  idOf(invoice.parent && invoice.parent.subscription_details && invoice.parent.subscription_details.subscription);

const getInvoiceMetadataUserId = (invoice) => {
  const candidates = [
    invoice.subscription_details && invoice.subscription_details.metadata,
    invoice.parent && invoice.parent.subscription_details && invoice.parent.subscription_details.metadata,
    invoice.metadata,
    invoice.lines && invoice.lines.data && invoice.lines.data[0] && invoice.lines.data[0].metadata,
  ];

  for (const metadata of candidates) {
    const userId = Number(metadata && metadata.userId);
    if (userId) return userId;
  }

  return null;
};

/**
 * Subscribe for the FIRST paid invoice of a subscription. Never throws.
 * Renewals are ignored through the deterministic `subscribe_{subscriptionId}`
 * event id; zero-amount (trial) invoices are ignored outright.
 */
const trackSubscribeFromInvoice = async (invoice) => {
  try {
    const config = getConfig();
    if (!isReady(config)) return { tracked: false, reason: "disabled" };
    if (!invoice) return { tracked: false, reason: "no_invoice" };

    const amountPaid = Number(invoice.amount_paid);
    if (!Number.isFinite(amountPaid) || amountPaid <= 0) {
      return { tracked: false, reason: "no_payment" };
    }

    const stripeSubscriptionId = getInvoiceSubscriptionId(invoice);
    if (!stripeSubscriptionId) return { tracked: false, reason: "no_subscription" };

    const stripeCustomerId = idOf(invoice.customer);
    const include = [{ model: SubscriptionPlan, as: "plan" }];

    let localSubscription = await UserSubscription.findOne({
      where: { stripeSubscriptionId },
      include,
    });

    if (!localSubscription && stripeCustomerId) {
      localSubscription = await UserSubscription.findOne({
        where: { stripeCustomerId },
        include,
        order: [["createdAt", "DESC"]],
      });
    }

    const userId = (localSubscription && localSubscription.userId) || getInvoiceMetadataUserId(invoice);
    if (!userId) return { tracked: false, reason: "user_not_found" };

    const user = await User.findByPk(userId);
    if (!user) return { tracked: false, reason: "user_not_found" };
    if (user.role === "admin") return { tracked: false, reason: "admin" };

    const lineItem = invoice.lines && invoice.lines.data && invoice.lines.data[0];
    const planName =
      (localSubscription && localSubscription.plan && localSubscription.plan.name) ||
      (lineItem && lineItem.description) ||
      "subscription";

    const attribution = (await MetaUserAttribution.findOne({ where: { userId: user.id } })) || {};
    const currency = String(invoice.currency || "").toUpperCase();
    const paidAt =
      (invoice.status_transitions && invoice.status_transitions.paid_at) ||
      invoice.created ||
      Math.floor(Date.now() / 1000);

    const event = buildEvent({
      eventName: "Subscribe",
      eventTime: paidAt,
      eventId: `subscribe_${stripeSubscriptionId}`,
      email: user.email,
      phone: user.mobile,
      userId: user.id,
      attribution: toPlain(attribution),
      customData: {
        value: toMajorUnits(amountPaid, currency),
        currency,
        content_name: planName,
        user_role: user.role,
      },
      defaultTrackingEnabled: config.defaultTrackingEnabled,
      defaultPhoneCountryCode: config.defaultPhoneCountryCode,
    });

    return await recordAndSend({ event, userId: user.id, config });
  } catch (error) {
    logError("trackSubscribeFromInvoice failed", error);
    return { tracked: false, reason: "error" };
  }
};

/**
 * Re-sends failed events, and pending events older than 5 minutes, that are
 * younger than 6 days and below the 8-attempt cap. Never throws.
 */
const retryPendingEvents = async () => {
  const summary = { attempted: 0, sent: 0, failed: 0 };

  try {
    const config = getConfig();
    if (!isReady(config)) return summary;

    const now = Date.now();
    const rows = await MetaConversionEvent.findAll({
      where: {
        attempts: { [Op.lt]: MAX_TOTAL_ATTEMPTS },
        createdAt: { [Op.gt]: new Date(now - RETRY_WINDOW_MS) },
        [Op.or]: [
          { status: "failed" },
          { status: "pending", createdAt: { [Op.lt]: new Date(now - PENDING_RETRY_AFTER_MS) } },
        ],
      },
      order: [["createdAt", "ASC"]],
      limit: RETRY_BATCH_SIZE,
    });

    for (const row of rows) {
      if (!row.payload) continue;

      const maxAttempts = Math.min(
        ATTEMPTS_PER_DISPATCH,
        MAX_TOTAL_ATTEMPTS - (Number(row.attempts) || 0)
      );

      try {
        const outcome = await dispatchEvent(row, config, { maxAttempts });
        summary.attempted += 1;
        if (outcome.ok) summary.sent += 1;
        else summary.failed += 1;
      } catch (error) {
        summary.attempted += 1;
        summary.failed += 1;
        logError(`retry of event ${row.id} failed`, error);
      }
    }
  } catch (error) {
    logError("retryPendingEvents failed", error);
  }

  return summary;
};

module.exports = {
  getConfig,
  postEvents,
  saveAttribution,
  trackRegistration,
  trackAttributionOnly,
  trackSubscribeFromInvoice,
  retryPendingEvents,
  flush,
  // Exposed for tests only.
  _private: {
    setRetryDelays: (delays) => {
      retryDelaysMs = delays;
    },
    resetWarnings: () => {
      warnedMissingToken = false;
    },
  },
};
