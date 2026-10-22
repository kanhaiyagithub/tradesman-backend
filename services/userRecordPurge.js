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

/**
 * Deletes a user's rows from every table that points at them, then the user.
 *
 * The database has foreign keys WITHOUT cascade (for example user_subscriptions.userId), so a bare
 * `user.destroy()` fails with ER_ROW_IS_REFERENCED_2 as soon as the user owns anything. The tables we know
 * about are cleared explicitly, in dependency order. A final pass then asks MySQL which other tables still
 * hold a foreign key to Users (old tables, columns added by past syncs) and clears those too, so the delete
 * cannot be blocked by a table this code has never heard of.
 *
 * Must run inside the caller's transaction: either everything goes or nothing does.
 */

const orWhere = (...clauses) => ({ [Op.or]: clauses.filter(Boolean) });

const findTable = async (tableNames, transaction) => {
  const existing = (await sequelize.getQueryInterface().showAllTables({ transaction })).map((table) =>
    String(typeof table === "string" ? table : table.tableName),
  );
  // Use the table's real spelling (a case-sensitive server cares), not ours.
  return existing.find((found) => tableNames.some((name) => name.toLowerCase() === found.toLowerCase())) || null;
};

/** Legacy tables that may not exist in every database: skipped when missing. */
const deleteFromOptionalTable = async (tableNames, column, ids, transaction) => {
  const table = await findTable(tableNames, transaction);
  if (!table) return;
  await sequelize.query(`DELETE FROM \`${table}\` WHERE \`${column}\` IN (:ids)`, {
    replacements: { ids },
    transaction,
  });
};

/** Every (table, column) that still has a foreign key to Users, except Users itself. */
const findRemainingUserReferences = async (transaction) => {
  const [rows] = await sequelize.query(
    `SELECT TABLE_NAME AS tableName, COLUMN_NAME AS columnName
       FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = DATABASE()
        AND LOWER(REFERENCED_TABLE_NAME) = 'users'
        AND REFERENCED_COLUMN_NAME = 'id'
        AND LOWER(TABLE_NAME) <> 'users'`,
    { transaction },
  );
  return rows;
};

/**
 * @param {number[]} userIds
 * @param {import("sequelize").Transaction} transaction
 * @returns {Promise<{ sweptTables: string[] }>} tables only the final catch-all pass had to clean
 */
const deleteUserRecords = async (userIds, transaction) => {
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

  // Chats: every conversation the user is in goes, with all of its messages (messages are soft-deleted by
  // default, so force the real delete).
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

  // Catch-all: anything that still holds a foreign key to these users would block the delete below.
  const sweptTables = [];
  for (const { tableName, columnName } of await findRemainingUserReferences(transaction)) {
    const [, meta] = await sequelize.query(
      `DELETE FROM \`${tableName}\` WHERE \`${columnName}\` IN (:ids)`,
      { replacements: { ids: userIds }, transaction },
    );
    if (Number(meta?.affectedRows ?? meta) > 0) sweptTables.push(`${tableName}.${columnName}`);
  }

  await User.destroy({ where: { id: userIds }, ...options });

  return { sweptTables };
};

module.exports = { deleteUserRecords };
