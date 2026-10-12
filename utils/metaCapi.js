const crypto = require("crypto");

/**
 * Pure helpers for the Meta Conversions API (app events).
 *
 * No database and no network access lives here: everything is a plain function
 * so it can be unit tested in isolation.
 */

const ZERO_DECIMAL_CURRENCIES = new Set([
  "BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA",
  "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF",
]);

const THREE_DECIMAL_CURRENCIES = new Set(["BHD", "JOD", "KWD", "OMR", "TND"]);

const MAX_ATTRIBUTION_JSON_LENGTH = 8 * 1024;
const MIN_PHONE_DIGITS = 8;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ANON_ID_PATTERN = /^[A-Za-z0-9._:-]{1,100}$/;
const IPV4_OR_IPV6_PATTERN = /^[0-9a-fA-F:.]{2,45}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

const STRING_FIELD_LIMITS = {
  appPackage: 150,
  appVersionCode: 32,
  appVersionName: 64,
  osVersion: 32,
  deviceModel: 100,
  locale: 32,
  timezoneAbbr: 16,
  timezoneName: 64,
  carrier: 100,
};

// field -> [min, max, integerOnly]
const NUMBER_FIELD_RANGES = {
  screenWidth: [1, 20000, true],
  screenHeight: [1, 20000, true],
  cpuCores: [1, 256, true],
  screenDensity: [0.1, 20, false],
  totalStorageGb: [0.01, 100000, false],
  freeStorageGb: [0.01, 100000, false],
};

const BOOLEAN_FIELDS = ["advertiserTrackingEnabled", "applicationTrackingEnabled"];

/** Fields a client may send; the model columns use the same names. */
const ATTRIBUTION_FIELDS = [
  "platform",
  "advertisingId",
  "anonId",
  ...BOOLEAN_FIELDS,
  ...Object.keys(STRING_FIELD_LIMITS),
  ...Object.keys(NUMBER_FIELD_RANGES),
];

const sha256 = (value) =>
  crypto.createHash("sha256").update(String(value), "utf8").digest("hex");

const normalizeEmail = (email) => {
  if (typeof email !== "string") return "";
  return email.trim().toLowerCase();
};

const hashEmail = (email) => {
  const normalized = normalizeEmail(email);
  return normalized ? sha256(normalized) : null;
};

/**
 * Digits-only phone including country code. A leading 0 (national format) is
 * replaced with the default country code. Returns "" when unusable.
 */
const normalizePhone = (phone, defaultCountryCode = "61") => {
  if (phone === null || phone === undefined) return "";

  let digits = String(phone).replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.replace(/^0+/, "");
  else if (digits.startsWith("0")) {
    digits = `${String(defaultCountryCode).replace(/\D/g, "")}${digits.replace(/^0+/, "")}`;
  }

  return digits.length >= MIN_PHONE_DIGITS ? digits : "";
};

const hashPhone = (phone, defaultCountryCode = "61") => {
  const normalized = normalizePhone(phone, defaultCountryCode);
  return normalized ? sha256(normalized) : null;
};

const hashExternalId = (userId) =>
  userId === null || userId === undefined || userId === ""
    ? null
    : sha256(String(userId));

/** Converts Stripe minor units to major units (e.g. cents -> dollars). */
const toMajorUnits = (amountMinor, currency) => {
  const amount = Number(amountMinor);
  if (!Number.isFinite(amount)) return 0;

  const code = String(currency || "").toUpperCase();
  if (ZERO_DECIMAL_CURRENCIES.has(code)) return amount;
  if (THREE_DECIMAL_CURRENCIES.has(code)) return Math.round(amount) / 1000;
  return Math.round(amount) / 100;
};

const cleanString = (value, maxLength) => {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const cleaned = String(value).replace(CONTROL_CHARS, "").trim().slice(0, maxLength);
  return cleaned || null;
};

const cleanNumber = (value, [min, max, integerOnly]) => {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !/^\s*-?\d+(\.\d+)?\s*$/.test(value)) return null;

  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) return null;
  return integerOnly ? Math.round(number) : Math.round(number * 100) / 100;
};

const cleanBoolean = (value) => {
  if (value === true || value === 1 || value === "1" || value === "true") return true;
  if (value === false || value === 0 || value === "0" || value === "false") return false;
  return null;
};

const cleanAdvertisingId = (value) => {
  const id = cleanString(value, 36);
  if (!id || !UUID_PATTERN.test(id)) return null;
  // Users who opted out of ad tracking report an all-zero ID.
  if (/^[0-]+$/.test(id)) return null;
  return id;
};

/**
 * Whitelists and sanitises an untrusted attribution payload (object or JSON
 * string). Returns null when the input is not usable at all, otherwise an
 * object holding ONLY valid fields (invalid or empty values are dropped).
 */
const sanitizeAttribution = (input) => {
  let source = input;

  if (typeof source === "string") {
    if (source.length > MAX_ATTRIBUTION_JSON_LENGTH) return null;
    try {
      source = JSON.parse(source);
    } catch (error) {
      return null;
    }
  }

  if (!source || typeof source !== "object" || Array.isArray(source)) return null;

  const result = {};
  const has = (key) => Object.prototype.hasOwnProperty.call(source, key);

  if (has("platform")) {
    const platform = cleanString(source.platform, 16);
    const lowered = platform ? platform.toLowerCase() : null;
    if (lowered === "android" || lowered === "ios") result.platform = lowered;
  }

  if (has("advertisingId")) {
    const advertisingId = cleanAdvertisingId(source.advertisingId);
    if (advertisingId) result.advertisingId = advertisingId;
  }

  if (has("anonId")) {
    const anonId = cleanString(source.anonId, 100);
    if (anonId && ANON_ID_PATTERN.test(anonId)) result.anonId = anonId;
  }

  BOOLEAN_FIELDS.forEach((field) => {
    if (!has(field)) return;
    const value = cleanBoolean(source[field]);
    if (value !== null) result[field] = value;
  });

  Object.entries(STRING_FIELD_LIMITS).forEach(([field, limit]) => {
    if (!has(field)) return;
    const value = cleanString(source[field], limit);
    if (value) result[field] = value;
  });

  Object.entries(NUMBER_FIELD_RANGES).forEach(([field, range]) => {
    if (!has(field)) return;
    const value = cleanNumber(source[field], range);
    if (value !== null) result[field] = value;
  });

  return result;
};

/** Sanitises the request IP / User-Agent that the server records itself. */
const sanitizeRequestContext = ({ ip, userAgent } = {}) => {
  const context = {};

  const cleanedIp = cleanString(ip, 64);
  const unwrappedIp = cleanedIp ? cleanedIp.replace(/^::ffff:/i, "") : null;
  if (unwrappedIp && IPV4_OR_IPV6_PATTERN.test(unwrappedIp)) {
    context.lastIp = unwrappedIp;
  }

  const cleanedAgent = cleanString(userAgent, 512);
  if (cleanedAgent) context.lastUserAgent = cleanedAgent;

  return context;
};

/**
 * Builds the 16-item extinfo array Meta expects for app events.
 * Unknown text becomes "" and unknown numbers become 0.
 */
const buildExtinfo = (attribution = {}) => {
  const text = (value) => (value === null || value === undefined ? "" : String(value));
  const num = (value) => {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  };

  return [
    attribution.platform === "ios" ? "i2" : "a2",
    text(attribution.appPackage),
    text(attribution.appVersionCode),
    text(attribution.appVersionName),
    text(attribution.osVersion),
    text(attribution.deviceModel),
    text(attribution.locale),
    text(attribution.timezoneAbbr),
    text(attribution.carrier),
    num(attribution.screenWidth),
    num(attribution.screenHeight),
    num(attribution.screenDensity),
    num(attribution.cpuCores),
    num(attribution.totalStorageGb),
    num(attribution.freeStorageGb),
    text(attribution.timezoneName),
  ];
};

/** Resolves the effective advertiser-tracking consent for an attribution row. */
const isAdvertiserTrackingEnabled = (attribution, defaultTrackingEnabled = true) => {
  const value = attribution ? attribution.advertiserTrackingEnabled : null;
  if (value === null || value === undefined) return Boolean(defaultTrackingEnabled);
  return Boolean(value);
};

/**
 * Builds the user_data object. When advertiser tracking is disabled only the
 * anonymous install ID is sent.
 */
const buildUserData = ({
  email,
  phone,
  userId,
  attribution = {},
  trackingEnabled,
  defaultPhoneCountryCode = "61",
}) => {
  const userData = {};
  const attr = attribution || {};

  if (trackingEnabled) {
    const em = hashEmail(email);
    if (em) userData.em = [em];

    const ph = hashPhone(phone, defaultPhoneCountryCode);
    if (ph) userData.ph = [ph];

    const externalId = hashExternalId(userId);
    if (externalId) userData.external_id = [externalId];

    const madid = cleanAdvertisingId(attr.advertisingId);
    if (madid) userData.madid = madid;
  }

  if (attr.anonId) userData.anon_id = attr.anonId;

  if (trackingEnabled) {
    if (attr.lastIp) userData.client_ip_address = attr.lastIp;
    if (attr.lastUserAgent) userData.client_user_agent = attr.lastUserAgent;
  }

  return userData;
};

/** True when user_data holds at least one identifier Meta can match on. */
const hasIdentifiers = (event) =>
  Boolean(event && event.user_data && Object.keys(event.user_data).length > 0);

/**
 * Builds one app event for the `data[]` array of the Conversions API.
 */
const buildEvent = ({
  eventName,
  eventTime,
  eventId,
  email,
  phone,
  userId,
  attribution = {},
  customData = null,
  defaultTrackingEnabled = true,
  defaultPhoneCountryCode = "61",
}) => {
  const attr = attribution || {};
  const trackingEnabled = isAdvertiserTrackingEnabled(attr, defaultTrackingEnabled);
  const applicationTracking =
    attr.applicationTrackingEnabled === null || attr.applicationTrackingEnabled === undefined
      ? true
      : Boolean(attr.applicationTrackingEnabled);

  const event = {
    event_name: eventName,
    event_time: Math.floor(Number(eventTime) || Date.now() / 1000),
    event_id: eventId,
    action_source: "app",
    user_data: buildUserData({
      email,
      phone,
      userId,
      attribution: attr,
      trackingEnabled,
      defaultPhoneCountryCode,
    }),
    app_data: {
      advertiser_tracking_enabled: trackingEnabled ? 1 : 0,
      application_tracking_enabled: applicationTracking ? 1 : 0,
      extinfo: buildExtinfo(attr),
    },
  };

  if (customData && Object.keys(customData).length > 0) {
    event.custom_data = customData;
  }

  return event;
};

module.exports = {
  ATTRIBUTION_FIELDS,
  sha256,
  normalizeEmail,
  hashEmail,
  normalizePhone,
  hashPhone,
  hashExternalId,
  toMajorUnits,
  sanitizeAttribution,
  sanitizeRequestContext,
  buildExtinfo,
  isAdvertiserTrackingEnabled,
  buildUserData,
  hasIdentifiers,
  buildEvent,
};
