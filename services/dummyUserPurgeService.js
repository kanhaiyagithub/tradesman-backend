const { Op } = require("sequelize");
const sequelize = require("../config/db");
const User = require("../models/User");
const TradesmanDetails = require("../models/TradesmanDetails");
const UserSubscription = require("../models/UserSubscription");
const TravelPlan = require("../models/locationModel");
const ClientTradeAlert = require("../models/clientTradeAlertModel");
const TravelPlanAlertMatch = require("../models/travelPlanAlertMatchModel");
const LiveProximityNotification = require("../models/LiveProximityNotification");
const TradesmanLiveLocation = require("../models/TradesmanLiveLocation");
const Hire = require("../models/hireModel");
const Review = require("../models/reviewModel");
const Message = require("../models/messageModel");
const Conversation = require("../models/conversationModel");
const ConversationParticipant = require("../models/conversationParticipantModel");
const Notification = require("../models/notificationModel");
const EmailNotificationLog = require("../models/EmailNotificationLog");
const MetaUserAttribution = require("../models/MetaUserAttribution");
const MetaConversionEvent = require("../models/MetaConversionEvent");
const storageService = require("./storage/storageService");
const { DummyUserError } = require("./dummyUserService");

/**
 * Removes test (dummy) users and EVERYTHING they own: profile, subscriptions, travel plans, alerts, matches,
 * hires, reviews, chats, notifications, device tokens, email logs and uploaded files.
 *
 * It never relies on database cascades (they may not exist) and it can only ever touch rows of users that
 * are flagged isDummy: a real user in `ids` makes the whole call fail before anything is deleted.
 */

const asList = (value) => {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return []; // MySQL may hand a JSON column back as text, so accept both
};

const orWhere = (...clauses) => ({ [Op.or]: clauses.filter(Boolean) });

/** Legacy tables that may not exist in every database: deleted with raw SQL, and skipped when missing. */
const deleteFromOptionalTable = async (tableNames, column, ids, transaction) => {
  const existing = (await sequelize.getQueryInterface().showAllTables()).map((table) =>
    String(typeof table === "string" ? table : table.tableName),
  );
  // Use the table's real spelling (a case-sensitive server cares), not ours.
  const table = existing.find((found) => tableNames.some((name) => name.toLowerCase() === found.toLowerCase()));
  if (!table) return;
  await sequelize.query(`DELETE FROM \`${table}\` WHERE \`${column}\` IN (:ids)`, {
    replacements: { ids },
    transaction,
  });
};

/**
 * @param {{ ids?: number[] }} [options] `ids`: only these test users (all must exist and be test users).
 *                                        Omit it to remove every test user.
 * @returns {Promise<{ deleted: number, filesRemoved: number }>}
 */
const purgeDummyUsers = async ({ ids = null } = {}) => {
  const where = { isDummy: true, ...(ids ? { id: ids } : {}) };
  const users = await User.findAll({ where, attributes: ["id", "profileImage"] });

  if (ids && users.length !== new Set(ids).size) {
    // A real user, or one that does not exist: refuse the whole request, delete nothing.
    throw new DummyUserError(404, "Test user not found");
  }

  const userIds = users.map((user) => user.id);
  if (!userIds.length) return { deleted: 0, filesRemoved: 0 };

  // A test user never talks to Stripe. If one somehow has a real subscription, stop rather than orphan billing.
  const stripeBacked = await UserSubscription.findOne({
    where: { userId: userIds, stripeSubscriptionId: { [Op.ne]: null } },
    attributes: ["id"],
  });
  if (stripeBacked) {
    throw new DummyUserError(409, "A test user has a real Stripe subscription and cannot be deleted here");
  }

  // Remember the files first; they are removed only after the database delete succeeded.
  const detailRows = await TradesmanDetails.findAll({ where: { userId: userIds } });
  const files = [
    ...users.filter((user) => user.profileImage).map((user) => ({ key: user.profileImage, category: "profile" })),
    ...detailRows.filter((row) => row.licenseDocument).map((row) => ({ key: row.licenseDocument, category: "license" })),
    ...detailRows.flatMap((row) => asList(row.portfolioPhotos).map((key) => ({ key, category: "portfolio" }))),
  ];

  await sequelize.transaction(async (transaction) => {
    const options = { transaction };

    const hireIds = (
      await Hire.findAll({
        where: orWhere({ clientId: userIds }, { tradesmanId: userIds }),
        attributes: ["id"],
        ...options,
      })
    ).map((hire) => hire.id);

    await Review.destroy({
      where: orWhere({ fromUserId: userIds }, { toUserId: userIds }, hireIds.length && { hireId: hireIds }),
      ...options,
    });
    if (hireIds.length) await Hire.destroy({ where: { id: hireIds }, ...options });

    const matchIds = (
      await TravelPlanAlertMatch.findAll({
        where: orWhere({ tradesmanId: userIds }, { clientId: userIds }),
        attributes: ["id"],
        ...options,
      })
    ).map((match) => match.id);

    await EmailNotificationLog.destroy({
      where: orWhere(
        { recipientUserId: userIds },
        { clientId: userIds },
        { tradesmanId: userIds },
        matchIds.length && { matchId: matchIds },
      ),
      ...options,
    });
    await LiveProximityNotification.destroy({
      where: orWhere({ tradesmanId: userIds }, { clientId: userIds }),
      ...options,
    });
    if (matchIds.length) await TravelPlanAlertMatch.destroy({ where: { id: matchIds }, ...options });
    await ClientTradeAlert.destroy({ where: { clientId: userIds }, ...options });
    await TradesmanLiveLocation.destroy({ where: { tradesmanId: userIds }, ...options });
    await TravelPlan.destroy({ where: { tradesmanId: userIds }, ...options });

    // Chats: every conversation a test user is in goes, with all of its messages (messages are soft-deleted
    // by default, so force the real delete).
    const participantRows = await ConversationParticipant.findAll({
      where: orWhere({ userId: userIds }, { otherUserId: userIds }),
      attributes: ["conversationId"],
      ...options,
    });
    const conversationRows = await Conversation.findAll({
      where: orWhere({ userOneId: userIds }, { userTwoId: userIds }),
      attributes: ["id"],
      ...options,
    });
    const conversationIds = [
      ...new Set([...participantRows.map((row) => row.conversationId), ...conversationRows.map((row) => row.id)]),
    ];

    await Message.destroy({
      where: orWhere({ senderId: userIds }, { receiverId: userIds }, conversationIds.length && { conversationId: conversationIds }),
      force: true,
      ...options,
    });
    await ConversationParticipant.destroy({
      where: orWhere({ userId: userIds }, { otherUserId: userIds }, conversationIds.length && { conversationId: conversationIds }),
      ...options,
    });
    if (conversationIds.length) await Conversation.destroy({ where: { id: conversationIds }, ...options });

    await Notification.destroy({ where: { userId: userIds }, ...options });
    await deleteFromOptionalTable(["device_tokens"], "user_id", userIds, transaction);
    await deleteFromOptionalTable(["PortfolioPhotos"], "userId", userIds, transaction);
    await MetaUserAttribution.destroy({ where: { userId: userIds }, ...options });
    await MetaConversionEvent.destroy({ where: { userId: userIds }, ...options });

    await UserSubscription.destroy({ where: { userId: userIds }, ...options });
    await TradesmanDetails.destroy({ where: { userId: userIds }, ...options });
    await User.destroy({ where: { id: userIds, isDummy: true }, ...options });
  });

  // The database is clean: now remove the uploaded files (best effort, a missing file is fine).
  const results = await Promise.allSettled(
    files.map(({ key, category }) => storageService.deleteObject(key, { category })),
  );

  return { deleted: userIds.length, filesRemoved: results.filter((result) => result.status === "fulfilled").length };
};

module.exports = { purgeDummyUsers };
