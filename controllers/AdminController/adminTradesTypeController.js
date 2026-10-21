const { Op } = require("sequelize");
const sequelize = require("../../config/db");
const TradesType = require("../../models/tradesTypeModel");
const TradesmanDetails = require("../../models/TradesmanDetails");
const ClientTradeAlert = require("../../models/clientTradeAlertModel");
const User = require("../../models/User");
const { sendPushNotification } = require("../notificationController");
const { sendTradesmanRejectedEmail } = require("../../services/emailService");
const { publishApprovalsUpdate } = require("../../services/adminEventService");
const {
  MAX_LABEL_LENGTH,
  sanitizeLabel,
  countLicenceImpact,
  askListedForLicence,
  autoApproveWaitingForTrade,
} = require("../../services/tradeLicenceService");

const MAX_FIELD_LENGTH = 255;

/** A validation or conflict problem with a ready-made HTTP status, thrown from inside a transaction. */
class TradeAdminError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Validates the licence fields of a create/update body. Returns { values } or throws TradeAdminError(400). */
const parseLicenceFields = (body) => {
  const values = {};

  if ("licenceRequired" in body) {
    if (typeof body.licenceRequired !== "boolean") {
      throw new TradeAdminError(400, "licenceRequired must be true or false");
    }
    values.licenceRequired = body.licenceRequired;
  }

  if ("licenceLabel" in body) {
    if (body.licenceLabel !== null && typeof body.licenceLabel !== "string") {
      throw new TradeAdminError(400, "licenceLabel must be text");
    }
    const label = sanitizeLabel(body.licenceLabel);
    if (label && label.length > MAX_LABEL_LENGTH) {
      throw new TradeAdminError(400, `licenceLabel must be ${MAX_LABEL_LENGTH} characters or less`);
    }
    values.licenceLabel = label;
  }

  return values;
};

const send = (res, status, success, message, data = null) =>
  res.status(status).json({ success, message, data });

const cleanField = (value) =>
  typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";

const parseId = (value) => {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
};

/**
 * GET /api/admin/trades
 * Lists every trade type, including inactive ones, for the dashboard.
 */
exports.listTradesTypes = async (req, res) => {
  try {
    const trades = await TradesType.findAll({ order: [["name", "ASC"]] });
    return send(res, 200, true, "Trades fetched", trades);
  } catch (error) {
    console.error("Admin list trades error:", error);
    return send(res, 500, false, "Server error");
  }
};

/**
 * POST /api/admin/trades  { name, category, licenceRequired?, licenceLabel? }
 * A trade that already exists is rejected; one that was deleted-by-deactivation
 * (isActive = false) is switched back on instead of duplicated (its licence settings are then left as they are:
 * change them with PATCH so the impact on existing tradespeople is handled).
 * A new licence-required trade without a label gets "<name> licence".
 */
exports.createTradesType = async (req, res) => {
  try {
    const name = cleanField(req.body?.name);
    const category = cleanField(req.body?.category);

    if (!name) return send(res, 400, false, "Name is required");
    if (!category) return send(res, 400, false, "Category is required");
    if (name.length > MAX_FIELD_LENGTH || category.length > MAX_FIELD_LENGTH) {
      return send(res, 400, false, `Name and category must be ${MAX_FIELD_LENGTH} characters or less`);
    }

    const licence = parseLicenceFields(req.body || {});

    const existing = await TradesType.findOne({ where: { name, category } });

    if (existing) {
      if (existing.isActive) {
        return send(res, 409, false, "This trade already exists in that category");
      }

      await existing.update({ isActive: true });
      return send(res, 200, true, "Existing trade reactivated", existing);
    }

    if (licence.licenceRequired && !licence.licenceLabel) licence.licenceLabel = `${name} licence`.slice(0, MAX_LABEL_LENGTH);

    const trade = await TradesType.create({ name, category, isActive: true, ...licence });
    await trade.reload(); // so the answer shows what is really stored, including the defaults
    return send(res, 201, true, "Trade created", trade);
  } catch (error) {
    if (error instanceof TradeAdminError) return send(res, error.status, false, error.message);
    console.error("Admin create trade error:", error);
    return send(res, 500, false, "Server error");
  }
};

/**
 * PATCH /api/admin/trades/:id
 * body (all optional): { name, category, isActive, licenceRequired, licenceLabel, applyToExisting }
 *
 *  - Renaming also updates the trade name copied onto every tradesperson's profile.
 *  - licenceRequired ON: nobody is delisted by default. With applyToExisting: true, listed tradespeople without a
 *    verified licence are put back in the review queue (full licence details) or asked to add one (rejected),
 *    and told so. Repeating the call changes nothing more.
 *  - licenceRequired OFF: paying members waiting for review in this trade are approved straight away.
 * The trade row is locked while this runs, so two admins cannot interleave.
 */
exports.updateTradesType = async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return send(res, 400, false, "id must be a positive integer");

    const body = req.body || {};
    const changes = {};

    if ("name" in body) {
      changes.name = cleanField(body.name);
      if (!changes.name) return send(res, 400, false, "Name cannot be empty");
    }
    if ("category" in body) {
      changes.category = cleanField(body.category);
      if (!changes.category) return send(res, 400, false, "Category cannot be empty");
    }
    if ((changes.name || "").length > MAX_FIELD_LENGTH || (changes.category || "").length > MAX_FIELD_LENGTH) {
      return send(res, 400, false, `Name and category must be ${MAX_FIELD_LENGTH} characters or less`);
    }
    if ("isActive" in body) {
      if (typeof body.isActive !== "boolean") return send(res, 400, false, "isActive must be true or false");
      changes.isActive = body.isActive;
    }
    Object.assign(changes, parseLicenceFields(body));

    let applyToExisting = false;
    if ("applyToExisting" in body) {
      if (typeof body.applyToExisting !== "boolean") {
        return send(res, 400, false, "applyToExisting must be true or false");
      }
      applyToExisting = body.applyToExisting;
    }

    if (!Object.keys(changes).length && !applyToExisting) return send(res, 400, false, "Nothing to change");

    const result = await sequelize.transaction(async (transaction) => {
      const trade = await TradesType.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
      if (!trade) throw new TradeAdminError(404, "Trade not found");

      const wasRequired = Boolean(trade.licenceRequired);
      const nextName = changes.name ?? trade.name;
      const nextCategory = changes.category ?? trade.category;
      const nextRequired = changes.licenceRequired ?? wasRequired;

      if (applyToExisting && !nextRequired) {
        throw new TradeAdminError(400, "applyToExisting only works when the trade requires a licence");
      }

      if (changes.name !== undefined || changes.category !== undefined) {
        const clash = await TradesType.findOne({
          where: { name: nextName, category: nextCategory, isActive: true, id: { [Op.ne]: id } },
          transaction,
        });
        if (clash) throw new TradeAdminError(409, "Another trade already has that name in that category");
      }

      // A licence-required trade always has a label: a cleared one falls back to "<name> licence".
      const nextLabel = "licenceLabel" in changes ? changes.licenceLabel : trade.licenceLabel;
      if (nextRequired && !nextLabel) {
        changes.licenceLabel = `${nextName} licence`.slice(0, MAX_LABEL_LENGTH);
      }

      await trade.update(changes, { transaction });

      if (changes.name !== undefined) {
        await TradesmanDetails.update({ tradeType: nextName }, { where: { tradeTypeId: id }, transaction });
      }

      const applied = applyToExisting
        ? await askListedForLicence(trade, { adminId: req.user.id, transaction })
        : null;
      const autoApproved = wasRequired && changes.licenceRequired === false
        ? await autoApproveWaitingForTrade(id, { transaction })
        : 0;

      return { trade, applied, autoApproved };
    });

    // Only now that everything is saved: tell the people affected, and refresh admins' queue badge.
    if (result.applied && result.applied.notify.length) {
      await notifyAskedForLicence(result.trade, result.applied.notify);
    }
    if (result.applied?.notify.length || result.autoApproved) {
      await publishApprovalsUpdate({ type: "decided" });
    }

    console.log(`[TRADES] admin ${req.user.id} changed trade ${id}`, {
      changed: Object.keys(changes),
      applyToExisting,
      pending: result.applied?.pending ?? 0,
      rejected: result.applied?.rejected ?? 0,
      autoApproved: result.autoApproved,
    });

    return send(res, 200, true, "Trade updated", {
      trade: result.trade,
      applied: result.applied && { pending: result.applied.pending, rejected: result.applied.rejected },
      autoApproved: result.autoApproved,
    });
  } catch (error) {
    if (error instanceof TradeAdminError) return send(res, error.status, false, error.message);
    console.error("Admin update trade error:", error);
    return send(res, 500, false, "Server error");
  }
};

/** In-app notification + push for everyone asked for a licence; rejected ones also get the rejection email. */
const notifyAskedForLicence = async (trade, notify) => {
  const users = await User.findAll({ where: { id: notify.map((item) => item.userId) } });
  const byId = new Map(users.map((user) => [user.id, user]));

  for (const item of notify) {
    const rejected = item.state === "rejected";
    await sendPushNotification(
      item.userId,
      "Licence needed",
      rejected
        ? `${trade.name} now requires a licence. Add your licence details to appear in search again.`
        : `${trade.name} now requires a licence. Your licence details are being reviewed, and you will appear in search again once they are approved.`,
      { type: "LICENCE_REQUIRED", tradeTypeId: trade.id },
    );
    if (rejected && byId.get(item.userId)) {
      sendTradesmanRejectedEmail({ user: byId.get(item.userId), reason: item.reason, rejectedAt: new Date() });
    }
  }
};

/**
 * GET /api/admin/trades/:id/licence-impact
 * Counts for the confirmation dialog, from the same rules the PATCH uses (test users excluded).
 */
exports.getLicenceImpact = async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return send(res, 400, false, "id must be a positive integer");

    const trade = await TradesType.findByPk(id);
    if (!trade) return send(res, 404, false, "Trade not found");

    return send(res, 200, true, "Licence impact", {
      trade: { id: trade.id, name: trade.name, licenceRequired: Boolean(trade.licenceRequired) },
      ...(await countLicenceImpact(id)),
    });
  } catch (error) {
    console.error("Admin licence impact error:", error);
    return send(res, 500, false, "Server error");
  }
};

/**
 * DELETE /api/admin/trades/:id
 * A trade nobody uses is removed. A trade that tradesmen or client alerts
 * still point at is refused (409) so their profiles are not orphaned; pass
 * ?deactivate=true to hide it from the app instead.
 */
exports.deleteTradesType = async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return send(res, 400, false, "id must be a positive integer");

    const trade = await TradesType.findByPk(id);
    if (!trade) return send(res, 404, false, "Trade not found");

    const [tradesmen, alerts] = await Promise.all([
      TradesmanDetails.count({ where: { tradeTypeId: id } }),
      ClientTradeAlert.count({ where: { tradeTypeId: id } }),
    ]);

    if (tradesmen || alerts) {
      if (String(req.query.deactivate).toLowerCase() === "true") {
        await trade.update({ isActive: false });
        return send(res, 200, true, "Trade is in use, so it was deactivated instead of deleted", {
          trade,
          inUse: { tradesmen, alerts },
        });
      }

      return send(
        res,
        409,
        false,
        "Trade is in use and cannot be deleted. Use ?deactivate=true to hide it from the app instead",
        { inUse: { tradesmen, alerts } }
      );
    }

    await trade.destroy();
    return send(res, 200, true, "Trade deleted");
  } catch (error) {
    console.error("Admin delete trade error:", error);
    return send(res, 500, false, "Server error");
  }
};
