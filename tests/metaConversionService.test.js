const assert = require("node:assert/strict");
const test = require("node:test");

// Point the DB at a dead address BEFORE anything loads config/db, so an
// un-mocked query fails fast instead of reaching a real database.
process.env.DB_HOST = "127.0.0.1";
process.env.DB_PORT = "1";
process.env.DB_NAME = "meta_test_unused";
process.env.DB_USER = "unused";
process.env.DB_PASS = "unused";

const FAKE_TOKEN = "fake-test-token-not-real";

const MetaConversionEvent = require("../models/MetaConversionEvent");
const MetaUserAttribution = require("../models/MetaUserAttribution");
const User = require("../models/User");
const UserSubscription = require("../models/UserSubscription");
const service = require("../services/metaConversionService");

const ENV_KEYS = [
  "META_CAPI_ENABLED",
  "META_CAPI_ACCESS_TOKEN",
  "META_DATASET_ID",
  "META_TEST_EVENT_CODE",
  "META_GRAPH_API_VERSION",
  "META_DEFAULT_TRACKING_ENABLED",
];

const originals = {
  fetch: globalThis.fetch,
  eventCreate: MetaConversionEvent.create,
  eventUpdate: MetaConversionEvent.update,
  eventFindAll: MetaConversionEvent.findAll,
  attrFindOne: MetaUserAttribution.findOne,
  attrCreate: MetaUserAttribution.create,
  attrUpdate: MetaUserAttribution.update,
  userFindByPk: User.findByPk,
  subFindOne: UserSubscription.findOne,
  consoleError: console.error,
};
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

let events; // rows by eventId
let updates; // [{ id, values }]
let fetchCalls; // [{ url, body }]
let fetchResponses; // queue of { status, body } or Error

const uniqueError = () => {
  const error = new Error("duplicate");
  error.name = "SequelizeUniqueConstraintError";
  return error;
};

const metaResponse = (status, body = {}) => ({ status, body });
const accepted = () => metaResponse(200, { events_received: 1, fbtrace_id: "trace-1" });

test.beforeEach(() => {
  process.env.META_CAPI_ENABLED = "true";
  process.env.META_CAPI_ACCESS_TOKEN = FAKE_TOKEN;
  process.env.META_DATASET_ID = "1813699159758304";
  process.env.META_TEST_EVENT_CODE = "";
  process.env.META_GRAPH_API_VERSION = "v23.0";
  process.env.META_DEFAULT_TRACKING_ENABLED = "true";

  events = new Map();
  updates = [];
  fetchCalls = [];
  fetchResponses = [];
  service._private.setRetryDelays([0, 0]);
  service._private.resetWarnings();
  console.error = () => {};

  let nextId = 1;
  MetaConversionEvent.create = async (values) => {
    if (events.has(values.eventId)) throw uniqueError();
    const row = { id: nextId, ...values };
    nextId += 1;
    events.set(values.eventId, row);
    return row;
  };
  MetaConversionEvent.update = async (values, { where }) => {
    updates.push({ id: where.id, values });
    return [1];
  };
  MetaConversionEvent.findAll = async () => [];
  MetaUserAttribution.findOne = async () => null;
  MetaUserAttribution.create = async () => ({});
  MetaUserAttribution.update = async () => [1];
  User.findByPk = async () => null;
  UserSubscription.findOne = async () => null;

  globalThis.fetch = async (url, options) => {
    fetchCalls.push({ url, body: JSON.parse(options.body) });
    const next = fetchResponses.length ? fetchResponses.shift() : accepted();
    if (next instanceof Error) throw next;
    return { ok: next.status >= 200 && next.status < 300, status: next.status, json: async () => next.body };
  };
});

test.afterEach(async () => {
  await service.flush();
  globalThis.fetch = originals.fetch;
  MetaConversionEvent.create = originals.eventCreate;
  MetaConversionEvent.update = originals.eventUpdate;
  MetaConversionEvent.findAll = originals.eventFindAll;
  MetaUserAttribution.findOne = originals.attrFindOne;
  MetaUserAttribution.create = originals.attrCreate;
  MetaUserAttribution.update = originals.attrUpdate;
  User.findByPk = originals.userFindByPk;
  UserSubscription.findOne = originals.subFindOne;
  console.error = originals.consoleError;
  ENV_KEYS.forEach((key) => {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  });
});

const newUser = (overrides = {}) => ({
  id: 5,
  email: "Person@Example.com",
  mobile: "0412345678",
  role: "client",
  ...overrides,
});

const register = (overrides = {}) =>
  service.trackRegistration({
    user: newUser(),
    method: "email",
    metaAttribution: JSON.stringify({ anonId: "anon-1234", advertisingId: "11111111-2222-4333-8444-555555555555" }),
    ip: "203.0.113.5",
    userAgent: "UA/1.0",
    ...overrides,
  });

const invoice = (overrides = {}) => ({
  id: "in_1",
  subscription: "sub_1",
  customer: "cus_1",
  amount_paid: 1999,
  currency: "aud",
  created: 1700000000,
  status_transitions: { paid_at: 1700000100 },
  lines: { data: [{ description: "Line plan" }] },
  ...overrides,
});

const mockSubscriptionUser = (userOverrides = {}) => {
  UserSubscription.findOne = async () => ({ userId: 5, plan: { name: "Pro" } });
  User.findByPk = async () => ({ id: 5, email: "p@example.com", mobile: null, role: "tradesman", ...userOverrides });
};

test("does nothing when META_CAPI_ENABLED is not true", async () => {
  process.env.META_CAPI_ENABLED = "false";

  const result = await register();
  await service.flush();

  assert.equal(result.tracked, false);
  assert.equal(events.size, 0);
  assert.equal(fetchCalls.length, 0);
});

test("registration stores the row first, then sends in the background", async () => {
  // Hold the HTTP call open: register() must still resolve.
  let releaseFetch;
  const gate = new Promise((resolve) => {
    releaseFetch = resolve;
  });
  const recordingFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    await gate;
    return recordingFetch(...args);
  };

  const result = await register();

  assert.equal(result.tracked, true);
  assert.equal(events.get("registration_5").status, "pending");
  assert.equal(updates.length, 0, "caller must not wait for the Meta response");

  releaseFetch();
  await service.flush();

  assert.equal(fetchCalls.length, 1);
  const { url, body } = fetchCalls[0];
  assert.equal(url, "https://graph.facebook.com/v23.0/1813699159758304/events");
  assert.equal(url.includes(FAKE_TOKEN), false, "token must not be in the URL");
  assert.equal(body.access_token, FAKE_TOKEN);
  assert.equal(body.data[0].event_name, "CompleteRegistration");
  assert.equal(body.data[0].event_id, "registration_5");
  assert.equal(body.data[0].custom_data.registration_method, "email");
  assert.equal(body.test_event_code, undefined);

  assert.equal(updates.at(-1).values.status, "sent");
  assert.equal(updates.at(-1).values.attempts, 1);
  assert.equal(updates.at(-1).values.fbtraceId, "trace-1");
});

test("stored payload holds hashed identifiers only and never the token", async () => {
  await register();
  await service.flush();

  const stored = JSON.stringify(events.get("registration_5").payload);
  assert.equal(stored.includes("Person@Example.com"), false);
  assert.equal(stored.toLowerCase().includes("person@example.com"), false);
  assert.equal(stored.includes("0412345678"), false);
  assert.equal(stored.includes(FAKE_TOKEN), false);
});

test("includes test_event_code when configured", async () => {
  process.env.META_TEST_EVENT_CODE = "TEST12345";

  await register();
  await service.flush();

  assert.equal(fetchCalls[0].body.test_event_code, "TEST12345");
  assert.equal(events.get("registration_5").isTest, true);
});

test("admin users are not tracked", async () => {
  const result = await register({ user: newUser({ role: "admin" }) });
  await service.flush();

  assert.equal(result.reason, "admin");
  assert.equal(events.size, 0);
  assert.equal(fetchCalls.length, 0);
});

test("a duplicate event_id is ignored", async () => {
  await register();
  await service.flush();
  const second = await register();
  await service.flush();

  assert.equal(second.tracked, false);
  assert.equal(second.reason, "duplicate");
  assert.equal(fetchCalls.length, 1);
});

test("tracking functions never throw when Meta or the database fail", async () => {
  fetchResponses = [new Error("socket hang up"), new Error("socket hang up"), new Error("socket hang up")];

  await assert.doesNotReject(async () => {
    await register();
    await service.flush();
  });
  assert.equal(updates.at(-1).values.status, "failed");

  MetaConversionEvent.create = async () => {
    throw new Error("database is down");
  };
  MetaUserAttribution.findOne = async () => {
    throw new Error("database is down");
  };

  await assert.doesNotReject(async () => {
    const result = await register({ user: newUser({ id: 6 }) });
    assert.equal(result.tracked, false);
    await service.trackSubscribeFromInvoice(invoice());
    await service.trackAttributionOnly({ userId: 6, metaAttribution: {} });
  });
});

test("retries transient 500 errors and then succeeds", async () => {
  fetchResponses = [metaResponse(500, { error: { message: "boom" } }), accepted()];

  await register();
  await service.flush();

  assert.equal(fetchCalls.length, 2);
  assert.equal(updates.at(-1).values.status, "sent");
  assert.equal(updates.at(-1).values.attempts, 2);
});

test("retries 429 and network errors up to 3 attempts, then marks failed", async () => {
  fetchResponses = [
    metaResponse(429, { error: { message: "slow down" } }),
    new Error("timeout"),
    metaResponse(503, { error: { message: "unavailable" } }),
  ];

  await register();
  await service.flush();

  assert.equal(fetchCalls.length, 3);
  const last = updates.at(-1).values;
  assert.equal(last.status, "failed");
  assert.equal(last.attempts, 3);
  assert.match(last.lastError, /503/);
});

test("does not retry a 400 response", async () => {
  fetchResponses = [metaResponse(400, { error: { message: "bad param", fbtrace_id: "trace-400" } })];

  await register();
  await service.flush();

  assert.equal(fetchCalls.length, 1);
  const last = updates.at(-1).values;
  assert.equal(last.status, "failed");
  assert.equal(last.attempts, 1);
  assert.equal(last.fbtraceId, "trace-400");
});

test("HTTP 200 with events_received 0 is a failure", async () => {
  fetchResponses = [metaResponse(200, { events_received: 0 })];

  await register();
  await service.flush();

  assert.equal(updates.at(-1).values.status, "failed");
  assert.equal(fetchCalls.length, 1);
});

test("an event with no identifiers is recorded as skipped and never sent", async () => {
  const result = await register({
    metaAttribution: { advertiserTrackingEnabled: false },
  });
  await service.flush();

  assert.equal(result.reason, "skipped");
  assert.equal(events.get("registration_5").status, "skipped");
  assert.equal(events.get("registration_5").payload, null);
  assert.equal(fetchCalls.length, 0);
});

test("Subscribe is sent for the first paid invoice", async () => {
  mockSubscriptionUser();

  const result = await service.trackSubscribeFromInvoice(invoice());
  await service.flush();

  assert.equal(result.tracked, true);
  const event = fetchCalls[0].body.data[0];
  assert.equal(event.event_name, "Subscribe");
  assert.equal(event.event_id, "subscribe_sub_1");
  assert.equal(event.event_time, 1700000100);
  assert.deepEqual(event.custom_data, {
    value: 19.99,
    currency: "AUD",
    content_name: "Pro",
    user_role: "tradesman",
  });
});

test("Subscribe reads the subscription id from the newer invoice shape", async () => {
  mockSubscriptionUser();

  await service.trackSubscribeFromInvoice(
    invoice({
      subscription: undefined,
      parent: { subscription_details: { subscription: "sub_new" } },
    })
  );
  await service.flush();

  assert.equal(fetchCalls[0].body.data[0].event_id, "subscribe_sub_new");
});

test("Subscribe is skipped when amount_paid is 0", async () => {
  mockSubscriptionUser();

  const result = await service.trackSubscribeFromInvoice(invoice({ amount_paid: 0 }));
  await service.flush();

  assert.equal(result.tracked, false);
  assert.equal(events.size, 0);
  assert.equal(fetchCalls.length, 0);
});

test("Subscribe is skipped when the user cannot be resolved", async () => {
  const result = await service.trackSubscribeFromInvoice(invoice());
  await service.flush();

  assert.equal(result.tracked, false);
  assert.equal(result.reason, "user_not_found");
  assert.equal(events.size, 0);
  assert.equal(fetchCalls.length, 0);
});

test("Subscribe falls back to subscription metadata userId", async () => {
  User.findByPk = async (id) => ({ id, email: "m@example.com", mobile: null, role: "client" });

  const result = await service.trackSubscribeFromInvoice(
    invoice({ subscription_details: { metadata: { userId: "9" } } })
  );
  await service.flush();

  assert.equal(result.tracked, true);
  assert.equal(events.get("subscribe_sub_1").userId, 9);
});

test("a renewal invoice for the same subscription is ignored", async () => {
  mockSubscriptionUser();

  await service.trackSubscribeFromInvoice(invoice());
  await service.flush();
  const renewal = await service.trackSubscribeFromInvoice(invoice({ id: "in_2", amount_paid: 1999 }));
  await service.flush();

  assert.equal(renewal.reason, "duplicate");
  assert.equal(fetchCalls.length, 1);
});

test("retryPendingEvents re-sends failed events and updates their rows", async () => {
  MetaConversionEvent.findAll = async () => [
    { id: 11, attempts: 3, isTest: false, payload: { event_name: "Subscribe", event_id: "subscribe_x", user_data: { anon_id: "a" } } },
    { id: 12, attempts: 3, isTest: false, payload: null },
  ];

  const summary = await service.retryPendingEvents();

  assert.deepEqual(summary, { attempted: 1, sent: 1, failed: 0 });
  assert.equal(updates.at(-1).id, 11);
  assert.equal(updates.at(-1).values.status, "sent");
  assert.equal(updates.at(-1).values.attempts, 4);
});

test("retryPendingEvents never exceeds 8 total attempts", async () => {
  fetchResponses = [
    metaResponse(500, {}),
    metaResponse(500, {}),
    metaResponse(500, {}),
  ];
  MetaConversionEvent.findAll = async () => [
    { id: 21, attempts: 7, isTest: false, payload: { event_name: "Subscribe", event_id: "subscribe_y", user_data: { anon_id: "a" } } },
  ];

  const summary = await service.retryPendingEvents();

  assert.equal(fetchCalls.length, 1);
  assert.equal(updates.at(-1).values.attempts, 8);
  assert.equal(summary.failed, 1);
});

test("saveAttribution does not overwrite known values with empty ones", async () => {
  let updated = null;
  MetaUserAttribution.findOne = async () => ({ userId: 5, anonId: "keep-me-1234", carrier: "Telstra" });
  MetaUserAttribution.update = async (values) => {
    updated = values;
    return [1];
  };

  const merged = await service.saveAttribution(
    5,
    { anonId: "", carrier: "   ", deviceModel: "Pixel 7", advertisingId: "00000000-0000-0000-0000-000000000000" },
    { ip: "203.0.113.5", userAgent: "UA/1.0" }
  );

  assert.deepEqual(updated, { deviceModel: "Pixel 7", lastIp: "203.0.113.5", lastUserAgent: "UA/1.0" });
  assert.equal(merged.anonId, "keep-me-1234");
  assert.equal(merged.carrier, "Telstra");
});
