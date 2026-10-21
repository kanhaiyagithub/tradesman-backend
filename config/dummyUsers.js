/**
 * Settings for test (dummy) users that admins create from the dashboard.
 *
 * DUMMY_USERS_ENABLED  "true" / "false". When unset: on everywhere except production, so production
 *                      must opt in explicitly.
 * DUMMY_USERS_MAX      Most test users that may exist at once (default 10).
 *
 * Read on every call (not cached) so a change takes effect after a restart and tests can set them.
 */
const DEFAULT_MAX = 10;

// A reserved top-level domain: nothing can be delivered there, so test accounts never bounce real mail.
const DUMMY_EMAIL_DOMAIN = "touringtrades.test";

const isDummyUsersEnabled = () => {
  const raw = String(process.env.DUMMY_USERS_ENABLED || "").trim().toLowerCase();
  if (raw === "true") return true;
  if (raw === "false") return false;
  return process.env.NODE_ENV !== "production";
};

const getDummyUsersMax = () => {
  const value = Number(process.env.DUMMY_USERS_MAX);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_MAX;
};

module.exports = { DUMMY_EMAIL_DOMAIN, isDummyUsersEnabled, getDummyUsersMax };
