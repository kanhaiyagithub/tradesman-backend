const TradesType = require("../../models/tradesTypeModel");
const TradesmanDetails = require("../../models/TradesmanDetails");
const ClientTradeAlert = require("../../models/clientTradeAlertModel");

const MAX_FIELD_LENGTH = 255;

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
 * POST /api/admin/trades  { name, category }
 * A trade that already exists is rejected; one that was deleted-by-deactivation
 * (isActive = false) is switched back on instead of duplicated.
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

    const existing = await TradesType.findOne({ where: { name, category } });

    if (existing) {
      if (existing.isActive) {
        return send(res, 409, false, "This trade already exists in that category");
      }

      await existing.update({ isActive: true });
      return send(res, 200, true, "Existing trade reactivated", existing);
    }

    const trade = await TradesType.create({ name, category, isActive: true });
    return send(res, 201, true, "Trade created", trade);
  } catch (error) {
    console.error("Admin create trade error:", error);
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
