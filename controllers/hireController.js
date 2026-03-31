const Hire = require("../models/hireModel");
const User = require("../models/User");
const { Op } = require("sequelize");
const { sendPushNotification } = require("./notificationController");

const sendResponse = (res, status, success, message, data = null) =>
  res.status(status).json({ success, message, data });

/* 1️⃣ Client → Hire Request */
exports.requestHire = async (req, res) => {
  try {
    const clientId = req.user.id;
    const { tradesmanId, jobDescription } = req.body;

    if (!tradesmanId)
      return sendResponse(res, 400, false, "tradesmanId required");

    // ✅ BLOCK multiple active hires
    const activeHire = await Hire.findOne({
      where: {
        clientId,
        tradesmanId,
        status: { [Op.in]: ["pending", "accepted"] }
      }
    });

    if (activeHire)
      return sendResponse(
        res,
        400,
        false,
        "Active hire already exists with this tradesman"
      );

    const hire = await Hire.create({
      clientId,
      tradesmanId,
      jobDescription,
      status: "pending",
      requestCompletion: false
    });

    // 🔥 PUSH NOTIFICATION (to TRADESMAN)
    const client = await User.findByPk(clientId, { attributes: ["name"] });
    sendPushNotification(
      tradesmanId,
      "New Job Request",
      `${client?.name || "A client"} wants to hire you for: ${jobDescription}`,
      { hireId: hire.id, type: "NEW_HIRE" }
    );

    return sendResponse(res, 201, true, "Hire request sent", hire);
  } catch (err) {
    return sendResponse(res, 500, false, err.message);
  }
};

/* 2️⃣ Tradesman → Accept / Reject */
exports.respondHire = async (req, res) => {
  try {
    const tradesmanId = req.user.id;
    const { hireId, action } = req.body;

    if (!hireId || !["accept", "reject"].includes(action))
      return sendResponse(res, 400, false, "Invalid action");

    const hire = await Hire.findOne({ where: { id: hireId, tradesmanId } });
    if (!hire) return sendResponse(res, 404, false, "Hire not found");

    hire.status = action === "accept" ? "accepted" : "rejected";
    await hire.save();

    // 🔥 PUSH NOTIFICATION (to CLIENT)
    const tradesman = await User.findByPk(tradesmanId, { attributes: ["name"] });
    sendPushNotification(
      hire.clientId,
      `Hire Request ${action === "accept" ? "Accepted" : "Rejected"}`,
      `${tradesman?.name || "The tradesman"} has ${action}ed your hire request.`,
      { hireId: hire.id, type: "HIRE_RESPONSE", status: hire.status }
    );

    return sendResponse(res, 200, true, "Hire updated", hire);
  } catch (err) {
    return sendResponse(res, 500, false, err.message);
  }
};

/* 3️⃣ Tradesman → Request Completion */
exports.requestJobCompletion = async (req, res) => {
  try {
    const tradesmanId = req.user.id;
    const { hireId } = req.body;

    const hire = await Hire.findOne({
      where: {
        id: hireId,
        tradesmanId,
        status: "accepted"
      }
    });

    if (!hire)
      return sendResponse(res, 404, false, "Active hire not found");

    if (hire.requestCompletion)
      return sendResponse(res, 400, false, "Already requested");

    hire.requestCompletion = true;
    await hire.save();

    // 🔥 PUSH NOTIFICATION (to CLIENT)
    const tradesman = await User.findByPk(tradesmanId, { attributes: ["name"] });
    sendPushNotification(
      hire.clientId,
      "Job Completion Requested",
      `${tradesman?.name || "The tradesman"} has marked the job as finished and is awaiting your confirmation.`,
      { hireId: hire.id, type: "COMPLETION_REQUESTED" }
    );

    return sendResponse(res, 200, true, "Completion request sent");
  } catch (err) {
    return sendResponse(res, 500, false, err.message);
  }
};

/* 4️⃣ Client → YES / NO */
exports.confirmJobCompletion = async (req, res) => {
  try {
    const clientId = req.user.id;
    const { hireId, confirm } = req.body;

    if (typeof confirm !== "boolean")
      return sendResponse(res, 400, false, "confirm must be boolean");

    const hire = await Hire.findOne({
      where: {
        id: hireId,
        clientId,
        status: "accepted",
        requestCompletion: true
      }
    });

    if (!hire)
      return sendResponse(res, 404, false, "No pending request found");

    if (!confirm) {
      hire.requestCompletion = false;
      await hire.save();
      return sendResponse(res, 200, true, "Completion rejected");
    }

    hire.status = "completed";
    hire.requestCompletion = false;
    await hire.save();

    // 🔥 PUSH NOTIFICATION (to TRADESMAN)
    const client = await User.findByPk(clientId, { attributes: ["name"] });
    sendPushNotification(
      hire.tradesmanId,
      "Job Completed & Confirmed",
      `${client?.name || "The client"} has confirmed the job completion.`,
      { hireId: hire.id, type: "JOB_COMPLETED" }
    );

    return sendResponse(res, 200, true, "Job completed", hire);
  } catch (err) {
    return sendResponse(res, 500, false, err.message);
  }
};

/* 5️⃣ ✅ Client → Check Pending Completion (FIXED) */
exports.getPendingCompletionStatus = async (req, res) => {
  try {
    const clientId = req.user.id;

    const hire = await Hire.findOne({
      where: {
        clientId,
        status: "accepted",
        requestCompletion: true
      },
      order: [["createdAt", "DESC"]]
    });

    if (!hire)
      return sendResponse(res, 200, true, "No pending request", {
        pending: false
      });

    return sendResponse(res, 200, true, "Pending completion request", {
      pending: true,
      hireId: hire.id,
      tradesmanId: hire.tradesmanId
    });
  } catch (err) {
    return sendResponse(res, 500, false, err.message);
  }
};

/* 6️⃣ Chat → Latest hire */
exports.getHireStatusForConversation = async (req, res) => {
  try {
    const me = req.user.id;
    const otherId = req.params.userId;

    const hire = await Hire.findOne({
      where: {
        [Op.or]: [
          { clientId: me, tradesmanId: otherId },
          { clientId: otherId, tradesmanId: me }
        ]
      },
      order: [["createdAt", "DESC"]]
    });

    return sendResponse(res, 200, true, "Hire status", hire);
  } catch (err) {
    return sendResponse(res, 500, false, err.message);
  }
};

/* 7️⃣ My Jobs */
exports.getMyJobs = async (req, res) => {
  try {
    const { id, role } = req.user;
    const filter = (req.query.filter || "all").toLowerCase();

    const where =
      role === "client"
        ? { clientId: id }
        : { tradesmanId: id };

    if (filter === "active")
      where.status = { [Op.in]: ["pending", "accepted"] };
    else if (filter === "completed")
      where.status = "completed";

    const jobs = await Hire.findAll({
      where,
      include: [
        { model: User, as: "client", attributes: ["id", "name"] },
        { model: User, as: "tradesman", attributes: ["id", "name"] }
      ],
      order: [["createdAt", "DESC"]]
    });

    return sendResponse(res, 200, true, "Jobs fetched", jobs);
  } catch (err) {
    return sendResponse(res, 500, false, err.message);
  }
};
