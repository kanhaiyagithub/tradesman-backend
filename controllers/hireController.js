const Hire = require("../models/hireModel");
const User = require("../models/User");
const TradesmanDetails = require("../models/TradesmanDetails");
const { Op } = require("sequelize");
const { sendPushNotification } = require("./notificationController");
const { getRequesterWorld, worldWhere } = require("../services/dummyWorld");

const ACTIVE_HIRE_STATUSES = ["pending", "accepted"];
const TERMINAL_HIRE_STATUSES = ["rejected", "completed", "cancelled"];
const MY_JOBS_FILTERS = ["all", "active", "completed", "cancelled"];

const sendResponse = (res, status, success, message, data = null) =>
  res.status(status).json({ success, message, data });

const toPositiveInteger = (value) => {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
};

const normalizeOptionalString = (value) => {
  if (value === undefined || value === null) {
    return "";
  }

  return String(value).trim();
};

const validateRole = (res, actualRole, expectedRole, message) => {
  if (actualRole !== expectedRole) {
    sendResponse(res, 403, false, message);
    return false;
  }

  return true;
};

const getParticipantRole = (hire, userId) => {
  if (Number(hire.clientId) === Number(userId)) {
    return "client";
  }

  if (Number(hire.tradesmanId) === Number(userId)) {
    return "tradesman";
  }

  return null;
};

const notifyUser = (userId, title, body, data) => {
  sendPushNotification(userId, title, body, data).catch((error) => {
    console.error("[HIRE_NOTIFICATION_ERROR]", error);
  });
};

/**
 * Real-time socket events for hire changes, sent to BOTH users of the hire.
 *
 * - "hire-updated": any hire change (requested, accepted/rejected, cancelled,
 *   completion requested/rejected, completed). Payload: { hireId, status,
 *   requestCompletion, clientId, tradesmanId, reason, at }.
 * - "completion-requested": the tradesman asked the client to confirm completion.
 * - "job-completed": the client confirmed completion.
 *
 * Push notifications still go out as before; this is the live-refresh channel.
 * Never throws: a socket problem must not fail the API request. Delivery is to
 * sockets connected to THIS server process only.
 */
const emitHireEvents = (hire, reason, extraEvents = []) => {
  try {
    // Lazy require: socket.js is initialised by the server, not by tests.
    const { emitToUser } = require("../socket");

    const payload = {
      hireId: hire.id,
      status: hire.status,
      requestCompletion: Boolean(hire.requestCompletion),
      clientId: hire.clientId,
      tradesmanId: hire.tradesmanId,
      reason,
      at: new Date().toISOString(),
    };

    for (const eventName of ["hire-updated", ...extraEvents]) {
      emitToUser(hire.clientId, eventName, payload);
      emitToUser(hire.tradesmanId, eventName, payload);
    }
  } catch (error) {
    console.error("[HIRE_SOCKET_EVENT_ERROR]", error.message);
  }
};

exports.requestHire = async (req, res) => {
  try {
    const clientId = req.user.id;
    const requesterRole = req.user.role;
    const tradesmanId = toPositiveInteger(req.body?.tradesmanId);
    const jobDescription = normalizeOptionalString(req.body?.jobDescription);

    if (
      !validateRole(
        res,
        requesterRole,
        "client",
        "Only clients can send hire requests"
      )
    ) {
      return;
    }

    if (!tradesmanId) {
      return sendResponse(res, 400, false, "tradesmanId must be a positive integer");
    }

    // jobDescription is optional: the mobile app does not collect one. Older
    // clients may still send it, so it is stored and shown when present.
    if (jobDescription.length > 2000) {
      return sendResponse(res, 400, false, "jobDescription must be 2000 characters or less");
    }

    // A real client cannot hire a test tradesman, nor a test client a real one: the target
    // simply "is not an approved tradesman" from the requester's side.
    const tradesman = await User.findOne({
      where: { id: tradesmanId, role: "tradesman", ...worldWhere(await getRequesterWorld(req)) },
      include: [
        {
          model: TradesmanDetails,
          as: "TradesmanDetail",
          where: { isApproved: true },
          required: true,
        },
      ],
    });

    if (!tradesman) {
      return sendResponse(res, 400, false, "Target must be an approved tradesman");
    }

    const activeHire = await Hire.findOne({
      where: {
        clientId,
        tradesmanId,
        status: { [Op.in]: ACTIVE_HIRE_STATUSES },
      },
    });

    if (activeHire) {
      return sendResponse(
        res,
        400,
        false,
        "Active hire already exists with this tradesman"
      );
    }

    const hire = await Hire.create({
      clientId,
      tradesmanId,
      jobDescription: jobDescription || null,
      status: "pending",
      requestCompletion: false,
    });

    const client = await User.findByPk(clientId, { attributes: ["name"] });
    notifyUser(
      tradesmanId,
      "New Job Request",
      jobDescription
        ? `${client?.name || "A client"} wants to hire you for: ${jobDescription}`
        : `${client?.name || "A client"} has sent you a hire request.`,
      { hireId: hire.id, type: "NEW_HIRE" }
    );
    emitHireEvents(hire, "requested");

    return sendResponse(res, 201, true, "Hire request sent", hire);
  } catch (err) {
    console.error("requestHire:", err);
    return sendResponse(res, 500, false, "Server error");
  }
};

exports.respondHire = async (req, res) => {
  try {
    const tradesmanId = req.user.id;
    const requesterRole = req.user.role;
    const hireId = toPositiveInteger(req.body?.hireId);
    const action = normalizeOptionalString(req.body?.action).toLowerCase();

    if (
      !validateRole(
        res,
        requesterRole,
        "tradesman",
        "Only tradesmen can respond to hire requests"
      )
    ) {
      return;
    }

    if (!hireId) {
      return sendResponse(res, 400, false, "hireId must be a positive integer");
    }

    if (!["accept", "reject"].includes(action)) {
      return sendResponse(res, 400, false, "action must be accept or reject");
    }

    const hire = await Hire.findOne({
      where: { id: hireId, tradesmanId, status: "pending" },
    });
    if (!hire) return sendResponse(res, 404, false, "Pending hire not found");

    hire.status = action === "accept" ? "accepted" : "rejected";
    hire.requestCompletion = false;
    await hire.save();

    const tradesman = await User.findByPk(tradesmanId, { attributes: ["name"] });
    notifyUser(
      hire.clientId,
      `Hire Request ${action === "accept" ? "Accepted" : "Rejected"}`,
      `${tradesman?.name || "The tradesman"} has ${action}ed your hire request.`,
      { hireId: hire.id, type: "HIRE_RESPONSE", status: hire.status }
    );
    emitHireEvents(hire, action === "accept" ? "accepted" : "rejected");

    return sendResponse(res, 200, true, "Hire updated", hire);
  } catch (err) {
    console.error("respondHire:", err);
    return sendResponse(res, 500, false, "Server error");
  }
};

exports.cancelHire = async (req, res) => {
  try {
    const userId = req.user.id;
    const role = req.user.role;
    const hireId = toPositiveInteger(req.body?.hireId);
    const reason = normalizeOptionalString(req.body?.reason);

    if (!["client", "tradesman"].includes(role)) {
      return sendResponse(res, 403, false, "Unsupported user role");
    }

    if (!hireId) {
      return sendResponse(res, 400, false, "hireId must be a positive integer");
    }

    if (reason.length > 500) {
      return sendResponse(res, 400, false, "reason must be 500 characters or less");
    }

    const hire = await Hire.findByPk(hireId);
    if (!hire) {
      return sendResponse(res, 404, false, "Hire not found");
    }

    const participantRole = getParticipantRole(hire, userId);
    if (!participantRole || participantRole !== role) {
      return sendResponse(res, 403, false, "Not allowed to cancel this hire");
    }

    if (TERMINAL_HIRE_STATUSES.includes(hire.status)) {
      return sendResponse(res, 400, false, `Cannot cancel a ${hire.status} hire`);
    }

    if (hire.requestCompletion) {
      return sendResponse(res, 400, false, "Cannot cancel while completion is pending");
    }

    hire.status = "cancelled";
    hire.requestCompletion = false;
    await hire.save();

    const actor = await User.findByPk(userId, { attributes: ["name"] });
    const recipientId = role === "client" ? hire.tradesmanId : hire.clientId;
    notifyUser(
      recipientId,
      "Hire Cancelled",
      `${actor?.name || "The other party"} cancelled the hire${reason ? `: ${reason}` : "."}`,
      { hireId: hire.id, type: "HIRE_CANCELLED", status: hire.status }
    );
    emitHireEvents(hire, "cancelled");

    return sendResponse(res, 200, true, "Hire cancelled", hire);
  } catch (err) {
    console.error("cancelHire:", err);
    return sendResponse(res, 500, false, "Server error");
  }
};

exports.requestJobCompletion = async (req, res) => {
  try {
    const tradesmanId = req.user.id;
    const requesterRole = req.user.role;
    const hireId = toPositiveInteger(req.body?.hireId);

    if (
      !validateRole(
        res,
        requesterRole,
        "tradesman",
        "Only tradesmen can request job completion"
      )
    ) {
      return;
    }

    if (!hireId) {
      return sendResponse(res, 400, false, "hireId must be a positive integer");
    }

    const hire = await Hire.findOne({
      where: {
        id: hireId,
        tradesmanId,
        status: "accepted",
      },
    });

    if (!hire) {
      return sendResponse(res, 404, false, "Active hire not found");
    }

    if (hire.requestCompletion) {
      return sendResponse(res, 400, false, "Already requested");
    }

    hire.requestCompletion = true;
    await hire.save();

    const tradesman = await User.findByPk(tradesmanId, { attributes: ["name"] });
    notifyUser(
      hire.clientId,
      "Job Completion Requested",
      `${tradesman?.name || "The tradesman"} has marked the job as finished and is awaiting your confirmation.`,
      { hireId: hire.id, type: "COMPLETION_REQUESTED" }
    );
    emitHireEvents(hire, "completion_requested", ["completion-requested"]);

    return sendResponse(res, 200, true, "Completion request sent");
  } catch (err) {
    console.error("requestJobCompletion:", err);
    return sendResponse(res, 500, false, "Server error");
  }
};

exports.confirmJobCompletion = async (req, res) => {
  try {
    const clientId = req.user.id;
    const requesterRole = req.user.role;
    const hireId = toPositiveInteger(req.body?.hireId);
    const { confirm } = req.body || {};

    if (
      !validateRole(
        res,
        requesterRole,
        "client",
        "Only clients can confirm job completion"
      )
    ) {
      return;
    }

    if (!hireId) {
      return sendResponse(res, 400, false, "hireId must be a positive integer");
    }

    if (typeof confirm !== "boolean") {
      return sendResponse(res, 400, false, "confirm must be boolean");
    }

    const hire = await Hire.findOne({
      where: {
        id: hireId,
        clientId,
        status: "accepted",
        requestCompletion: true,
      },
    });

    if (!hire) {
      return sendResponse(res, 404, false, "No pending request found");
    }

    if (!confirm) {
      hire.requestCompletion = false;
      await hire.save();
      emitHireEvents(hire, "completion_rejected");
      return sendResponse(res, 200, true, "Completion rejected");
    }

    hire.status = "completed";
    hire.requestCompletion = false;
    await hire.save();

    const client = await User.findByPk(clientId, { attributes: ["name"] });
    notifyUser(
      hire.tradesmanId,
      "Job Completed & Confirmed",
      `${client?.name || "The client"} has confirmed the job completion.`,
      { hireId: hire.id, type: "JOB_COMPLETED" }
    );
    emitHireEvents(hire, "completed", ["job-completed"]);

    return sendResponse(res, 200, true, "Job completed", hire);
  } catch (err) {
    console.error("confirmJobCompletion:", err);
    return sendResponse(res, 500, false, "Server error");
  }
};

exports.getPendingCompletionStatus = async (req, res) => {
  try {
    const clientId = req.user.id;
    const requesterRole = req.user.role;

    if (
      !validateRole(
        res,
        requesterRole,
        "client",
        "Only clients can view pending completion requests"
      )
    ) {
      return;
    }

    const hire = await Hire.findOne({
      where: {
        clientId,
        status: "accepted",
        requestCompletion: true,
      },
      order: [["createdAt", "DESC"]],
    });

    if (!hire) {
      return sendResponse(res, 200, true, "No pending request", {
        pending: false,
      });
    }

    return sendResponse(res, 200, true, "Pending completion request", {
      pending: true,
      hireId: hire.id,
      tradesmanId: hire.tradesmanId,
    });
  } catch (err) {
    console.error("getPendingCompletionStatus:", err);
    return sendResponse(res, 500, false, "Server error");
  }
};

exports.getHireStatusForConversation = async (req, res) => {
  try {
    const me = req.user.id;
    const otherId = toPositiveInteger(req.params.userId);

    if (!otherId) {
      return sendResponse(res, 400, false, "userId must be a positive integer");
    }

    const hire = await Hire.findOne({
      where: {
        [Op.or]: [
          { clientId: me, tradesmanId: otherId },
          { clientId: otherId, tradesmanId: me },
        ],
      },
      order: [["createdAt", "DESC"]],
    });

    return sendResponse(res, 200, true, "Hire status", hire);
  } catch (err) {
    console.error("getHireStatusForConversation:", err);
    return sendResponse(res, 500, false, "Server error");
  }
};

exports.getMyJobs = async (req, res) => {
  try {
    const { id, role } = req.user;
    const filter = normalizeOptionalString(req.query.filter || "all").toLowerCase();

    if (!["client", "tradesman"].includes(role)) {
      return sendResponse(res, 403, false, "Unsupported user role");
    }

    if (!MY_JOBS_FILTERS.includes(filter)) {
      return sendResponse(
        res,
        400,
        false,
        `filter must be one of: ${MY_JOBS_FILTERS.join(", ")}`
      );
    }

    const where =
      role === "client"
        ? { clientId: id }
        : { tradesmanId: id };

    if (filter === "active") {
      where.status = { [Op.in]: ACTIVE_HIRE_STATUSES };
    } else if (filter !== "all") {
      where.status = filter;
    }

    const jobs = await Hire.findAll({
      where,
      include: [
        { model: User, as: "client", attributes: ["id", "name"] },
        { model: User, as: "tradesman", attributes: ["id", "name"] },
      ],
      order: [["createdAt", "DESC"]],
    });

    return sendResponse(res, 200, true, "Jobs fetched", jobs);
  } catch (err) {
    console.error("getMyJobs:", err);
    return sendResponse(res, 500, false, "Server error");
  }
};
