const assert = require("node:assert/strict");
const test = require("node:test");

const {
  sha256,
  hashEmail,
  hashPhone,
  hashExternalId,
  normalizePhone,
  sanitizeAttribution,
  sanitizeRequestContext,
  buildExtinfo,
  toMajorUnits,
  buildEvent,
  hasIdentifiers,
} = require("../utils/metaCapi");

const ADVERTISING_ID = "11111111-2222-4333-8444-555555555555";
const ANON_ID = "anon-install-1234";

test("sha256 matches known vectors", () => {
  assert.equal(
    sha256("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
  );
  assert.equal(
    sha256(""),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  );
});

test("email is trimmed and lowercased before hashing", () => {
  const expected = "973dfe463ec85785f5f95af5ba3906eedb2d931c24e69824a89ea65dba4e813b";
  assert.equal(hashEmail("  Test@Example.COM "), expected);
  assert.equal(hashEmail("test@example.com"), expected);
  assert.equal(hashEmail(""), null);
  assert.equal(hashEmail(null), null);
});

test("phone numbers are normalised to digits with a country code", () => {
  assert.equal(normalizePhone("0412345678", "61"), "61412345678");
  assert.equal(normalizePhone("0412 345 678", "61"), "61412345678");
  assert.equal(normalizePhone("+61 412 345 678", "61"), "61412345678");
  assert.equal(normalizePhone("0064211234567", "61"), "64211234567");
  assert.equal(normalizePhone("0412345678", "44"), "44412345678");
  assert.equal(hashPhone("0412345678", "61"), sha256("61412345678"));
});

test("short or missing phone numbers are dropped", () => {
  assert.equal(normalizePhone("1234567"), "");
  assert.equal(normalizePhone("04123"), "");
  assert.equal(normalizePhone(""), "");
  assert.equal(normalizePhone(null), "");
  assert.equal(hashPhone("123"), null);
});

test("external id is the SHA-256 of the user id", () => {
  assert.equal(hashExternalId(42), sha256("42"));
  assert.equal(hashExternalId(null), null);
});

test("sanitizeAttribution rejects junk input", () => {
  assert.equal(sanitizeAttribution(null), null);
  assert.equal(sanitizeAttribution(undefined), null);
  assert.equal(sanitizeAttribution("not json"), null);
  assert.equal(sanitizeAttribution("[1,2,3]"), null);
  assert.equal(sanitizeAttribution([1, 2]), null);
  assert.equal(sanitizeAttribution(42), null);
  assert.equal(sanitizeAttribution("x".repeat(10000)), null);
});

test("sanitizeAttribution keeps only whitelisted, valid values", () => {
  const result = sanitizeAttribution({
    platform: "Android",
    advertisingId: ADVERTISING_ID,
    anonId: ANON_ID,
    advertiserTrackingEnabled: "true",
    applicationTrackingEnabled: 0,
    appPackage: "com.example.app\u0000",
    deviceModel: "x".repeat(500),
    screenWidth: "1080",
    screenHeight: 2400,
    screenDensity: 2.756,
    cpuCores: 8,
    isAdmin: true,
    lastIp: "6.6.6.6",
    __proto__: { polluted: true },
  });

  assert.equal(result.platform, "android");
  assert.equal(result.advertisingId, ADVERTISING_ID);
  assert.equal(result.anonId, ANON_ID);
  assert.equal(result.advertiserTrackingEnabled, true);
  assert.equal(result.applicationTrackingEnabled, false);
  assert.equal(result.appPackage, "com.example.app");
  assert.equal(result.deviceModel.length, 100);
  assert.equal(result.screenWidth, 1080);
  assert.equal(result.screenDensity, 2.76);
  assert.equal(result.isAdmin, undefined);
  assert.equal(result.lastIp, undefined);
  assert.equal(result.polluted, undefined);
});

test("sanitizeAttribution drops invalid field values", () => {
  const result = sanitizeAttribution({
    platform: "windows",
    advertisingId: "not-a-uuid",
    anonId: "bad id with spaces!",
    advertiserTrackingEnabled: "maybe",
    screenWidth: -5,
    cpuCores: "lots",
    deviceModel: { nested: true },
    carrier: "   ",
  });

  assert.deepEqual(result, {});
});

test("sanitizeAttribution drops the all-zero advertising ID", () => {
  const result = sanitizeAttribution({
    advertisingId: "00000000-0000-0000-0000-000000000000",
    anonId: ANON_ID,
  });

  assert.equal(result.advertisingId, undefined);
  assert.equal(result.anonId, ANON_ID);
});

test("sanitizeAttribution accepts a JSON string", () => {
  const result = sanitizeAttribution(JSON.stringify({ anonId: ANON_ID, cpuCores: 4 }));
  assert.deepEqual(result, { anonId: ANON_ID, cpuCores: 4 });
});

test("sanitizeRequestContext validates the IP and trims the User-Agent", () => {
  assert.deepEqual(sanitizeRequestContext({ ip: "::ffff:203.0.113.5", userAgent: "UA/1.0" }), {
    lastIp: "203.0.113.5",
    lastUserAgent: "UA/1.0",
  });
  assert.deepEqual(sanitizeRequestContext({ ip: "<script>", userAgent: "" }), {});
});

test("extinfo always has exactly 16 items", () => {
  const empty = buildExtinfo({});
  assert.equal(empty.length, 16);
  assert.equal(empty[0], "a2");
  assert.equal(empty[9], 0);

  const full = buildExtinfo({
    platform: "ios",
    appPackage: "com.example.app",
    appVersionCode: "12",
    appVersionName: "1.2.0",
    osVersion: "17.1",
    deviceModel: "iPhone14,2",
    locale: "en_AU",
    timezoneAbbr: "AEST",
    carrier: "Telstra",
    screenWidth: 1170,
    screenHeight: 2532,
    screenDensity: 3,
    cpuCores: 6,
    totalStorageGb: 128,
    freeStorageGb: 40.5,
    timezoneName: "Australia/Sydney",
  });

  assert.equal(full.length, 16);
  assert.equal(full[0], "i2");
  assert.equal(full[15], "Australia/Sydney");
  assert.equal(full[14], 40.5);
});

test("amounts convert to major units, zero-decimal aware", () => {
  assert.equal(toMajorUnits(1999, "aud"), 19.99);
  assert.equal(toMajorUnits(1999, "AUD"), 19.99);
  assert.equal(toMajorUnits(1500, "JPY"), 1500);
  assert.equal(toMajorUnits(5000, "krw"), 5000);
  assert.equal(toMajorUnits(1234, "KWD"), 1.234);
  assert.equal(toMajorUnits("abc", "AUD"), 0);
});

const baseEventInput = {
  eventName: "CompleteRegistration",
  eventTime: 1700000000,
  eventId: "registration_7",
  email: "Test@Example.com",
  phone: "0412345678",
  userId: 7,
  attribution: {
    platform: "android",
    advertisingId: ADVERTISING_ID,
    anonId: ANON_ID,
    lastIp: "203.0.113.5",
    lastUserAgent: "UA/1.0",
  },
  customData: { registration_method: "email", user_role: "client", status: true },
};

test("event includes hashed identifiers when tracking is enabled", () => {
  const event = buildEvent({
    ...baseEventInput,
    attribution: { ...baseEventInput.attribution, advertiserTrackingEnabled: true },
  });

  assert.equal(event.action_source, "app");
  assert.equal(event.event_id, "registration_7");
  assert.deepEqual(event.user_data.em, [hashEmail("test@example.com")]);
  assert.deepEqual(event.user_data.ph, [sha256("61412345678")]);
  assert.deepEqual(event.user_data.external_id, [sha256("7")]);
  assert.equal(event.user_data.madid, ADVERTISING_ID);
  assert.equal(event.user_data.anon_id, ANON_ID);
  assert.equal(event.user_data.client_ip_address, "203.0.113.5");
  assert.equal(event.user_data.client_user_agent, "UA/1.0");
  assert.equal(event.app_data.advertiser_tracking_enabled, 1);
  assert.equal(event.app_data.extinfo.length, 16);
  assert.equal(JSON.stringify(event).includes("Test@Example.com"), false);
});

test("tracking disabled sends only anon_id", () => {
  const event = buildEvent({
    ...baseEventInput,
    attribution: { ...baseEventInput.attribution, advertiserTrackingEnabled: false },
  });

  assert.deepEqual(event.user_data, { anon_id: ANON_ID });
  assert.equal(event.app_data.advertiser_tracking_enabled, 0);
  assert.equal(hasIdentifiers(event), true);
});

test("tracking disabled without anon_id leaves no identifiers", () => {
  const event = buildEvent({
    ...baseEventInput,
    attribution: { advertiserTrackingEnabled: false, advertisingId: ADVERTISING_ID },
  });

  assert.deepEqual(event.user_data, {});
  assert.equal(hasIdentifiers(event), false);
});

test("unknown consent falls back to the configured default", () => {
  const optedIn = buildEvent({ ...baseEventInput, defaultTrackingEnabled: true });
  assert.ok(optedIn.user_data.em);
  assert.equal(optedIn.app_data.advertiser_tracking_enabled, 1);

  const optedOut = buildEvent({ ...baseEventInput, defaultTrackingEnabled: false });
  assert.deepEqual(optedOut.user_data, { anon_id: ANON_ID });
  assert.equal(optedOut.app_data.advertiser_tracking_enabled, 0);
});
