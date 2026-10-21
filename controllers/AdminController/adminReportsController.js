const User = require("../../models/User");
const UserSubscription = require("../../models/UserSubscription");
const SubscriptionPlan = require("../../models/SubscriptionPlan");
const { Parser } = require("json2csv");
const { sanitizeCsvRows } = require("../../utils/csvSafe");
const {
  parsePaging,
  buildUsersFilter,
  buildSubscriptionsFilter,
} = require("../../services/adminReportQueries");

/**
 * Both reports and both CSV exports take the same filters:
 *   users:         search (name/email), role (client|tradesman), verified (true|false)
 *   subscriptions: search (user name/email, plan name), planId, status
 *   both:          dummy = exclude (default: real users only) | include | only (test users)
 * The JSON reports also take page/limit (limit 1..100). Without page/limit they return every
 * matching row, as before; with them they return { data, meta: { total, page, perPage } }.
 * The CSV exports ignore paging and export everything that matches the filters.
 */

const USER_ATTRIBUTES = ["id", "name", "email", "role", "isVerified", "createdAt", "isDummy"];
const USER_ORDER = [["createdAt", "DESC"], ["id", "DESC"]];

// No Stripe ids here: the dashboard does not need them.
const SUBSCRIPTION_ATTRIBUTES = [
  "id", "userId", "planId", "status", "currentPeriodEnd", "cancelAtPeriodEnd",
  "trialEndsAt", "startDate", "createdAt",
];
const SUBSCRIPTION_ORDER = [["createdAt", "DESC"], ["id", "DESC"]];
const subscriptionInclude = () => [
  { model: User, as: "user", attributes: ["name", "email", "isDummy"], required: false },
  { model: SubscriptionPlan, as: "plan", attributes: ["name", "priceMonthly"], required: false },
];

const USER_CSV_FIELDS = USER_ATTRIBUTES;
const SUBSCRIPTION_CSV_FIELDS = ["user", "email", "plan", "price", "status", "currentPeriodEnd", "isDummy"];

const badRequest = (res, message) => res.status(400).json({ success: false, message });

const sendCsv = (res, filename, fields, rows) => {
  // Explicit fields so an empty result is still a valid CSV with a header row.
  const csv = new Parser({ fields }).parse(sanitizeCsvRows(rows));
  res.header("Content-Type", "text/csv");
  res.attachment(filename);
  res.send(csv);
};

/* ================= USERS REPORT ================= */
const getUsersReport = async (req, res) => {
  try {
    const filter = buildUsersFilter(req.query);
    if (filter.error) return badRequest(res, filter.error);

    const paging = parsePaging(req.query);
    const options = { where: filter.where, attributes: USER_ATTRIBUTES, order: USER_ORDER };

    if (!paging.paged) {
      return res.json({ success: true, data: await User.findAll(options) });
    }

    const { count, rows } = await User.findAndCountAll({
      ...options,
      limit: paging.limit,
      offset: paging.offset,
    });
    return res.json({
      success: true,
      data: rows,
      meta: { total: count, page: paging.page, perPage: paging.limit },
    });
  } catch (err) {
    console.error("Users Report Error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch users report" });
  }
};

/* ================= EXPORT USERS CSV ================= */
const exportUsersCSV = async (req, res) => {
  try {
    const filter = buildUsersFilter(req.query);
    if (filter.error) return badRequest(res, filter.error);

    const users = await User.findAll({
      where: filter.where,
      attributes: USER_ATTRIBUTES,
      order: USER_ORDER,
      raw: true,
    });
    return sendCsv(res, "users.csv", USER_CSV_FIELDS, users);
  } catch (err) {
    console.error("Export Users CSV Error:", err);
    return res.status(500).json({ success: false });
  }
};

/* ================= SUBSCRIPTIONS REPORT ================= */
const getSubscriptionsReport = async (req, res) => {
  try {
    const filter = buildSubscriptionsFilter(req.query);
    if (filter.error) return badRequest(res, filter.error);

    const paging = parsePaging(req.query);
    const options = {
      where: filter.where,
      attributes: SUBSCRIPTION_ATTRIBUTES,
      include: subscriptionInclude(),
      order: SUBSCRIPTION_ORDER,
    };

    if (!paging.paged) {
      return res.json({ success: true, data: await UserSubscription.findAll(options) });
    }

    const [{ count, rows }, plans] = await Promise.all([
      UserSubscription.findAndCountAll({ ...options, limit: paging.limit, offset: paging.offset }),
      // The plan names for the dashboard's filter dropdown.
      SubscriptionPlan.findAll({ attributes: ["id", "name"], order: [["name", "ASC"]] }),
    ]);
    return res.json({
      success: true,
      data: rows,
      meta: {
        total: count,
        page: paging.page,
        perPage: paging.limit,
        plans: plans.map((plan) => ({ id: plan.id, name: plan.name })),
      },
    });
  } catch (err) {
    console.error("Subscriptions Report Error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch subscriptions report" });
  }
};

/* ================= EXPORT SUBSCRIPTIONS CSV ================= */
const exportSubscriptionsCSV = async (req, res) => {
  try {
    const filter = buildSubscriptionsFilter(req.query);
    if (filter.error) return badRequest(res, filter.error);

    const subs = await UserSubscription.findAll({
      where: filter.where,
      attributes: SUBSCRIPTION_ATTRIBUTES,
      include: subscriptionInclude(),
      order: SUBSCRIPTION_ORDER,
    });

    const data = subs.map((s) => ({
      user: s.user?.name || "",
      email: s.user?.email || "",
      plan: s.plan?.name || "",
      price: s.plan?.priceMonthly || 0,
      status: s.status,
      currentPeriodEnd: s.currentPeriodEnd ? new Date(s.currentPeriodEnd).toISOString() : "",
      isDummy: Boolean(s.user?.isDummy),
    }));
    return sendCsv(res, "subscriptions.csv", SUBSCRIPTION_CSV_FIELDS, data);
  } catch (err) {
    console.error("Export Subscriptions CSV Error:", err);
    return res.status(500).json({ success: false });
  }
};

/* ✅ EXPORT FUNCTIONS (IMPORTANT) */
module.exports = {
  getUsersReport,
  exportUsersCSV,
  getSubscriptionsReport,
  exportSubscriptionsCSV,
};
