const { Op, fn, col } = require("sequelize");
const User = require("../../models/User");
const UserSubscription = require("../../models/UserSubscription");
const SubscriptionPlan = require("../../models/SubscriptionPlan");
const { countAwaitingReview } = require("../../services/pendingApprovalsService");

// Test (dummy) users are real rows flagged isDummy; statistics only count the real ones.
const REAL_USERS = { isDummy: false };
/** Joins a subscription to its user, keeping only real users' subscriptions (no columns selected). */
const realSubscriber = () => ({ model: User, as: "user", attributes: [], where: REAL_USERS, required: true });

const SUBSCRIPTION_STATUSES = [
  "trialing",
  "active",
  "incomplete",
  "past_due",
  "canceled",
  "unpaid",
];
const SIGNUP_MONTHS = 12;

/**
 * Builds the last `months` calendar months (oldest first, ending at `now`'s month)
 * and fills each with the matching count from `rows` ({ year, month, count }).
 */
const buildMonthlySeries = (rows, now = new Date(), months = SIGNUP_MONTHS) => {
  const counts = new Map(
    rows.map((row) => [`${Number(row.year)}-${Number(row.month)}`, Number(row.count) || 0])
  );

  return Array.from({ length: months }, (_, index) => {
    const date = new Date(now.getFullYear(), now.getMonth() - (months - 1 - index), 1);
    const year = date.getFullYear();
    const month = date.getMonth() + 1;
    return { year, month, count: counts.get(`${year}-${month}`) || 0 };
  });
};

/* =======================
   SUMMARY API (single call for the admin Overview page)
======================= */
exports.getSummary = async (req, res) => {
  try {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const seriesStart = new Date(now.getFullYear(), now.getMonth() - (SIGNUP_MONTHS - 1), 1);

    const [
      totalUsers,
      totalClients,
      totalTradesmen,
      verifiedTradesmen,
      newUsersThisMonth,
      pendingApprovals,
      signupRows,
      statusRows,
      activeRevenueRow,
      newRevenueRow,
    ] = await Promise.all([
      // Every figure below ignores test (dummy) users, so Overview only reflects real activity.
      User.count({ where: REAL_USERS }),
      User.count({ where: { ...REAL_USERS, role: "client" } }),
      User.count({ where: { ...REAL_USERS, role: "tradesman" } }),
      User.count({ where: { ...REAL_USERS, role: "tradesman", isVerified: true } }),
      User.count({ where: { ...REAL_USERS, createdAt: { [Op.gte]: startOfMonth } } }),
      // Awaiting review = subscribed and never reviewed or resubmitted
      // (rejected ones wait on the tradesman). Same rule as the sidebar badge.
      countAwaitingReview().then((counts) => counts.total),
      User.findAll({
        attributes: [
          [fn("YEAR", col("createdAt")), "year"],
          [fn("MONTH", col("createdAt")), "month"],
          [fn("COUNT", col("id")), "count"],
        ],
        where: { ...REAL_USERS, createdAt: { [Op.gte]: seriesStart } },
        group: [fn("YEAR", col("createdAt")), fn("MONTH", col("createdAt"))],
        raw: true,
      }),
      UserSubscription.findAll({
        attributes: ["status", [fn("COUNT", col("UserSubscription.id")), "count"]],
        include: [realSubscriber()],
        group: [col("UserSubscription.status")],
        raw: true,
      }),
      // Recurring revenue: monthly price of every currently active subscription.
      UserSubscription.findAll({
        attributes: [[fn("SUM", col("plan.priceMonthly")), "total"]],
        where: { status: "active" },
        include: [{ model: SubscriptionPlan, as: "plan", attributes: [], required: true }, realSubscriber()],
        raw: true,
      }),
      // Subscriptions that started this month and are active.
      UserSubscription.findAll({
        attributes: [[fn("SUM", col("plan.priceMonthly")), "total"]],
        where: { status: "active", createdAt: { [Op.gte]: startOfMonth } },
        include: [{ model: SubscriptionPlan, as: "plan", attributes: [], required: true }, realSubscriber()],
        raw: true,
      }),
    ]);

    const byStatus = Object.fromEntries(SUBSCRIPTION_STATUSES.map((status) => [status, 0]));
    statusRows.forEach((row) => {
      byStatus[row.status] = Number(row.count) || 0;
    });

    return res.json({
      success: true,
      data: {
        generatedAt: now.toISOString(),
        users: {
          total: totalUsers,
          clients: totalClients,
          tradesmen: totalTradesmen,
          newThisMonth: newUsersThisMonth,
        },
        tradesmen: {
          total: totalTradesmen,
          verified: verifiedTradesmen,
          pendingApprovals,
        },
        subscriptions: {
          byStatus,
          active: byStatus.active,
          total: Object.values(byStatus).reduce((sum, n) => sum + n, 0),
        },
        revenue: {
          monthlyRecurring: Number(activeRevenueRow[0]?.total) || 0,
          newThisMonth: Number(newRevenueRow[0]?.total) || 0,
        },
        signups: buildMonthlySeries(signupRows, now),
      },
    });
  } catch (error) {
    console.error("Dashboard summary error:", error);
    return res.status(500).json({
      success: false,
      message: "Dashboard summary failed",
    });
  }
};

exports.buildMonthlySeries = buildMonthlySeries;

/* =======================
   OVERVIEW API
======================= */
exports.getOverviewStats = async (req, res) => {
  try {
    const totalUsers = await User.count({ where: REAL_USERS });

    const totalClients = await User.count({
      where: { ...REAL_USERS, role: "client" },
    });

    const activeTradesmen = await User.count({
      where: { ...REAL_USERS, role: "tradesman" },
    });

    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const subscriptions = await UserSubscription.findAll({
      where: {
        status: "active",
        createdAt: { [Op.gte]: startOfMonth },
      },
      include: [
        {
          model: SubscriptionPlan,
          as: "plan",
          attributes: ["priceMonthly"],
        },
        realSubscriber(),
      ],
    });

    const monthlyRevenue = subscriptions.reduce(
      (sum, sub) => sum + Number(sub.plan?.priceMonthly || 0),
      0
    );

    return res.json({
      success: true,
      data: {
        totalUsers,
        totalClients,
        activeTradesmen,
        monthlyRevenue,
      },
    });
  } catch (error) {
    console.error("Dashboard error:", error);
    return res.status(500).json({
      success: false,
      message: "Dashboard load failed",
    });
  }
};

/* =======================
   ANALYTICS API
======================= */
exports.getAnalytics = async (req, res) => {
  try {
    const userGrowth = await User.findAll({
      attributes: [
        [fn("MONTH", col("createdAt")), "month"],
        [fn("COUNT", col("id")), "count"],
      ],
      where: REAL_USERS,
      group: [fn("MONTH", col("createdAt"))],
      order: [[fn("MONTH", col("createdAt")), "ASC"]],
    });

    const subscriptions = await UserSubscription.findAll({
      where: { status: "active" },
      include: [
        {
          model: SubscriptionPlan,
          as: "plan",
          attributes: ["priceMonthly"],
        },
        realSubscriber(),
      ],
    });

    const monthlyRevenue = subscriptions.reduce(
      (sum, s) => sum + Number(s.plan?.priceMonthly || 0),
      0
    );

    const tradesmenStats = {
      total: await User.count({ where: { ...REAL_USERS, role: "tradesman" } }),
      verified: await User.count({
        where: { ...REAL_USERS, role: "tradesman", isVerified: true },
      }),
      pending: await User.count({
        where: { ...REAL_USERS, role: "tradesman", isVerified: false },
      }),
    };

    return res.json({
      success: true,
      data: {
        userGrowth,
        monthlyRevenue,
        tradesmenStats,
      },
    });
  } catch (err) {
    console.error("Analytics Error:", err);
    return res.status(500).json({
      success: false,
      message: "Analytics load failed",
    });
  }
};
