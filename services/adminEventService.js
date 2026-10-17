const { countAwaitingReview } = require("./pendingApprovalsService");

const ADMIN_ROOM = "admins";
const APPROVALS_EVENT = "approvals:update";

/** Emits to every connected admin dashboard. Silent when sockets are not running. */
const emitToAdmins = (eventName, payload) => {
  try {
    // Required lazily: socket.js pulls in services that import this module.
    require("../socket").getIO().to(ADMIN_ROOM).emit(eventName, payload);
    return true;
  } catch {
    // Socket server not initialised (tests, scripts, a separate worker process).
    return false;
  }
};

/**
 * Tells admin dashboards the review queue changed.
 *   type "new"         a subscribed tradesman needs verifying
 *   type "resubmitted" a rejected tradesman resubmitted their profile
 *   type "decided"     an admin approved/rejected someone (just refresh the count)
 * Never throws, so it is safe inside request handlers and the Stripe webhook.
 */
const publishApprovalsUpdate = async ({ type, tradesman = null }) => {
  try {
    const counts = await countAwaitingReview();
    return emitToAdmins(APPROVALS_EVENT, {
      type,
      count: counts.total,
      resubmitted: counts.resubmitted,
      tradesman: tradesman
        ? { userId: tradesman.userId, name: tradesman.name, businessName: tradesman.businessName }
        : null,
      at: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Admin approvals event error:", error.message);
    return false;
  }
};

/**
 * Drops every open dashboard socket that belongs to `adminId` (used when that admin is deleted).
 * Never throws; a no-op when sockets are not running.
 */
const disconnectAdminSockets = async (adminId) => {
  try {
    const sockets = await require("../socket").getIO().in(ADMIN_ROOM).fetchSockets();
    sockets
      .filter((socket) => socket.isAdmin && Number(socket.user?.id) === Number(adminId))
      .forEach((socket) => socket.disconnect(true));
  } catch {
    // Socket server not initialised.
  }
};

module.exports = {
  ADMIN_ROOM,
  APPROVALS_EVENT,
  emitToAdmins,
  publishApprovalsUpdate,
  disconnectAdminSockets,
};
