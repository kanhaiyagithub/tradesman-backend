const TradesmanDetails = require('../models/TradesmanDetails');
const User = require('../models/User');
const transporter = require('../config/email');
const { Op } = require('sequelize');
const { sendPushNotification } = require('./notificationController');

const send = (res, code, success, message, data = null) =>
  res.status(code).json({ success, message, data });

const parsePagination = (req) => {
  const page = Math.max(parseInt(req.query.page || 1), 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit || 10), 1), 100);
  const offset = (page - 1) * limit;
  return { page, limit, offset };
};

// ✅ GET PENDING
async function getPending(req, res) {
  try {
    const { page, limit, offset } = parsePagination(req);
    const { search, tradeType } = req.query;

    const whereDetail = { isApproved: false };
    if (tradeType) whereDetail.tradeType = tradeType;

    const result = await TradesmanDetails.findAndCountAll({
      where: whereDetail,
      include: [{
        model: User,
        attributes: ['id', 'name', 'email', 'mobile', 'role', 'isVerified'],
        where: search ? {
          [Op.or]: [
            { name: { [Op.iLike]: `%${search}%` } },
            { email: { [Op.iLike]: `%${search}%` } }
          ]
        } : undefined
      }],
      order: [['createdAt', 'DESC']],
      limit,
      offset
    });

    return send(res, 200, true, 'Pending tradesmen fetched', {
      meta: { total: result.count, page, perPage: limit },
      data: result.rows
    });
  } catch (err) {
    console.error(err);
    return send(res, 500, false, 'Server error');
  }
}

// ✅ APPROVE
async function approve(req, res) {
  try {
    const { userId } = req.params;

    const details = await TradesmanDetails.findOne({ where: { userId } });
    if (!details) return send(res, 404, false, 'Tradesman details not found');

    details.isApproved = true;
    details.approvedBy = req.user.id;
    details.approvedAt = new Date();
    await details.save();

    const user = await User.findByPk(userId);
    if (user && 'isVerified' in user) {
      user.isVerified = true;
      await user.save();
    }

    // 🔥 PUSH NOTIFICATION (to USER)
    sendPushNotification(
      userId,
      "Profile Approved! 🎉",
      "Congratulations! Your tradesman profile has been approved. You can now start receiving hire requests.",
      { type: "PROFILE_APPROVED" }
    );

    return send(res, 200, true, 'Tradesman approved', { user, details });
  } catch (err) {
    console.error(err);
    return send(res, 500, false, 'Server error');
  }
}

// ✅ REJECT
async function reject(req, res) {
  try {
    const { userId } = req.params;
    const { reason } = req.body;

    const details = await TradesmanDetails.findOne({ where: { userId } });
    if (!details) return send(res, 404, false, 'Tradesman details not found');

    details.isApproved = false;
    details.rejectionReason = reason;
    details.approvedBy = req.user.id;
    details.approvedAt = new Date();
    await details.save();

    const user = await User.findByPk(userId);
    if (user && 'isVerified' in user) {
      user.isVerified = false;
      await user.save();
    }

    // 🔥 PUSH NOTIFICATION (to USER)
    sendPushNotification(
      userId,
      "Profile Update",
      `Your tradesman application was not approved. Reason: ${reason || "No reason provided."}`,
      { type: "PROFILE_REJECTED", reason: reason || "" }
    );

    return send(res, 200, true, 'Tradesman rejected', { user, details });
  } catch (err) {
    console.error(err);
    return send(res, 500, false, 'Server error');
  }
}

// ✅ GET ONE
async function getOne(req, res) {
  try {
    const { userId } = req.params;

    const details = await TradesmanDetails.findOne({
      where: { userId },
      include: [{ model: User }]
    });

    if (!details) return send(res, 404, false, 'Not found');
    return send(res, 200, true, 'Fetched', details);
  } catch (err) {
    console.error(err);
    return send(res, 500, false, 'Server error');
  }
}

module.exports = { getPending, approve, reject, getOne };
