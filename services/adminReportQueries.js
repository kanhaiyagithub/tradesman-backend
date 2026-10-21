const { Op } = require("sequelize");

const USER_ROLES = ["client", "tradesman"];
const SUBSCRIPTION_STATUSES = ["trialing", "active", "incomplete", "past_due", "canceled", "unpaid"];
const MAX_SEARCH_LENGTH = 100;

/** "%" and "_" typed by an admin are literal characters, not LIKE wildcards. */
const escapeLike = (value) => String(value).replace(/[\\%_]/g, "\\$&");

const likeTerm = (query) => {
  const search = String(query.search || "").trim().slice(0, MAX_SEARCH_LENGTH);
  return search ? { [Op.like]: `%${escapeLike(search)}%` } : null;
};

/**
 * Paging is opt-in so existing callers that pass no paging params still get the full list.
 * `page` is 1-based; `limit` is 1..100 (default 10).
 */
const parsePaging = (query) => {
  const paged = query.page !== undefined || query.limit !== undefined;
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 10, 1), 100);
  return { paged, page, limit, offset: (page - 1) * limit };
};

const DUMMY_MODES = ["exclude", "include", "only"];

/**
 * Test (dummy) users: `dummy` = exclude (default, real users only) | include (everyone) | only (test users).
 * Returns { value } where value is true/false for "only"/"exclude" or undefined for "include",
 * or { error }.
 */
const parseDummyMode = (query) => {
  const mode = query.dummy === undefined || query.dummy === "" ? "exclude" : String(query.dummy);
  if (!DUMMY_MODES.includes(mode)) {
    return { error: `dummy must be one of: ${DUMMY_MODES.join(", ")}` };
  }
  return { value: mode === "include" ? undefined : mode === "only" };
};

/** Users report filters: search (name/email), role, verified, dummy. Returns { where } or { error }. */
const buildUsersFilter = (query) => {
  const where = {};

  const dummy = parseDummyMode(query);
  if (dummy.error) return { error: dummy.error };
  if (dummy.value !== undefined) where.isDummy = dummy.value;

  const like = likeTerm(query);
  if (like) where[Op.or] = [{ name: like }, { email: like }];

  if (query.role) {
    if (!USER_ROLES.includes(query.role)) {
      return { error: `role must be one of: ${USER_ROLES.join(", ")}` };
    }
    where.role = query.role;
  }

  if (query.verified !== undefined && query.verified !== "") {
    if (!["true", "false"].includes(String(query.verified))) {
      return { error: "verified must be true or false" };
    }
    where.isVerified = String(query.verified) === "true";
  }

  return { where };
};

/** Subscriptions report filters: search (user name/email, plan name), planId, status, dummy. */
const buildSubscriptionsFilter = (query) => {
  const where = {};

  const dummy = parseDummyMode(query);
  if (dummy.error) return { error: dummy.error };
  if (dummy.value !== undefined) where["$user.isDummy$"] = dummy.value;

  const like = likeTerm(query);
  if (like) {
    where[Op.or] = [{ "$user.name$": like }, { "$user.email$": like }, { "$plan.name$": like }];
  }

  if (query.planId) {
    const planId = Number(query.planId);
    if (!Number.isInteger(planId) || planId <= 0) {
      return { error: "planId must be a positive integer" };
    }
    where.planId = planId;
  }

  if (query.status) {
    if (!SUBSCRIPTION_STATUSES.includes(query.status)) {
      return { error: `status must be one of: ${SUBSCRIPTION_STATUSES.join(", ")}` };
    }
    where.status = query.status;
  }

  return { where };
};

module.exports = {
  DUMMY_MODES,
  parseDummyMode,
  USER_ROLES,
  SUBSCRIPTION_STATUSES,
  escapeLike,
  parsePaging,
  buildUsersFilter,
  buildSubscriptionsFilter,
};
