const { DataTypes } = require("sequelize");

// Licence requirements per trade.
//
//   trades_type.licenceRequired  regulated trades need a licence (number, expiry, document) approved by an admin
//   trades_type.licenceLabel     what the app calls it, e.g. "Plumbing licence (QBCC)"
//   TradesmanDetails.licenceVerified  an admin approved this tradesman's licence for a licence-required trade
//
// Everything below can be run again safely: columns are added only if missing, trades are matched by
// normalised NAME (ids differ between servers) and only rows still at their defaults are flagged, so an
// admin's later edits are never overwritten, and the backfills only touch rows that still need it.
//
// NOTE FOR THE CLIENT: the starter list and labels below are a convenient starting point, not legal advice.
// Licensing rules (and for example dollar thresholds) must be confirmed before launch; every trade can be
// changed from the dashboard (Trades page).

const TRADES = "trades_type";
const DETAILS = "TradesmanDetails";
const USERS = "Users";

const STARTER_TRADES = [
  { name: "Electrician", category: "Electrical", label: "Electrical licence (Queensland)" },
  { name: "Plumber", category: "Plumbing", label: "Plumbing licence (QBCC)" },
  { name: "Gas Fitter", category: "Plumbing", label: "Gas fitting licence (QBCC)" },
  { name: "Builder", category: "Building", label: "Builder licence (QBCC)" },
  { name: "Air-conditioning Technician", category: "Air conditioning", label: "Air-conditioning licence (QBCC)" },
  { name: "Roofer", category: "Building", label: "Roofing licence (QBCC)" },
  { name: "Waterproofer", category: "Building", label: "Waterproofing licence (QBCC)" },
  { name: "Painter", category: "Painting", label: "Painting licence (QBCC)" },
  { name: "Tiler", category: "Building", label: "Tiling licence (QBCC)" },
  { name: "Carpenter", category: "Building", label: "Carpentry licence (QBCC)" },
];

// "Air-conditioning  Technician" and "air conditioning technician" are the same trade.
const normalise = (name) => String(name || "").toLowerCase().replace(/[^a-z0-9]/g, "");

const graceDays = () => {
  const value = Number(process.env.SUBSCRIPTION_ACCESS_GRACE_DAYS);
  return process.env.SUBSCRIPTION_ACCESS_GRACE_DAYS !== undefined && Number.isFinite(value) && value >= 0 ? value : 2;
};

module.exports = {
  up: async ({ context: queryInterface }) => {
    const sequelize = queryInterface.sequelize;

    /* ---- 1. columns (each only if missing) ---- */
    const tradeColumns = await queryInterface.describeTable(TRADES);
    if (!tradeColumns.licenceRequired) {
      await queryInterface.addColumn(TRADES, "licenceRequired", {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      });
    }
    if (!tradeColumns.licenceLabel) {
      await queryInterface.addColumn(TRADES, "licenceLabel", { type: DataTypes.STRING(120), allowNull: true });
    }

    const detailColumns = await queryInterface.describeTable(DETAILS);
    if (!detailColumns.licenceVerified) {
      await queryInterface.addColumn(DETAILS, "licenceVerified", {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      });
    }

    /* ---- 2. starter trades and 3. backfills, in one transaction ---- */
    await sequelize.transaction(async (transaction) => {
      const [existing] = await sequelize.query(`SELECT id, name, licenceRequired, licenceLabel FROM \`${TRADES}\``, { transaction });
      const byName = new Map(existing.map((trade) => [normalise(trade.name), trade]));

      for (const starter of STARTER_TRADES) {
        const found = byName.get(normalise(starter.name));

        if (!found) {
          await sequelize.query(
            `INSERT INTO \`${TRADES}\` (name, category, isActive, licenceRequired, licenceLabel, createdAt, updatedAt)
             VALUES (:name, :category, 1, 1, :label, NOW(), NOW())`,
            { replacements: starter, transaction },
          );
        } else if (!found.licenceRequired && !found.licenceLabel) {
          // Still at its defaults: flag it. A trade an admin already edited is left alone.
          await sequelize.query(
            `UPDATE \`${TRADES}\` SET licenceRequired = 1, licenceLabel = :label, updatedAt = NOW() WHERE id = :id`,
            { replacements: { id: found.id, label: starter.label }, transaction },
          );
        }
      }

      // Approved tradespeople of a licence-required trade who already gave full licence details: their licence
      // was checked when they were approved, so they keep a "licence verified" badge.
      await sequelize.query(
        `UPDATE \`${DETAILS}\` d JOIN \`${TRADES}\` t ON t.id = d.tradeTypeId
         SET d.licenceVerified = 1
         WHERE d.licenceVerified = 0 AND d.isApproved = 1 AND t.licenceRequired = 1
           AND d.licenseNumber IS NOT NULL AND d.licenseNumber <> ''
           AND d.licenseDocument IS NOT NULL AND d.licenseDocument <> ''
           AND d.licenseExpiry IS NOT NULL`,
        { transaction },
      );

      // Unlicensed trades need no review: anyone waiting who is already a paying member is approved now.
      // (Unsubscribed ones are approved when they subscribe. Rejected ones and test users are never touched.)
      const cutoff = new Date(Date.now() - graceDays() * 24 * 60 * 60 * 1000);
      const [waiting] = await sequelize.query(
        `SELECT d.id AS detailsId, d.userId AS userId
         FROM \`${DETAILS}\` d
         JOIN \`${TRADES}\` t ON t.id = d.tradeTypeId
         JOIN \`${USERS}\` u ON u.id = d.userId
         WHERE d.isApproved = 0 AND d.verificationStatus IN ('pending', 'resubmitted')
           AND t.licenceRequired = 0 AND u.isDummy = 0
           AND EXISTS (
             SELECT 1 FROM user_subscriptions s
             WHERE s.userId = d.userId AND s.status IN ('active', 'trialing', 'past_due')
               AND (s.currentPeriodEnd IS NULL OR s.currentPeriodEnd > :cutoff)
           )`,
        { replacements: { cutoff }, transaction },
      );

      if (waiting.length) {
        await sequelize.query(
          `UPDATE \`${DETAILS}\`
           SET isApproved = 1, verificationStatus = 'approved', licenceVerified = 0,
               approvedBy = NULL, approvedAt = NOW(), rejectionReason = NULL
           WHERE id IN (:ids)`,
          { replacements: { ids: waiting.map((row) => row.detailsId) }, transaction },
        );
        await sequelize.query(`UPDATE \`${USERS}\` SET isVerified = 1 WHERE id IN (:ids)`, {
          replacements: { ids: waiting.map((row) => row.userId) },
          transaction,
        });
      }
    });
  },

  // Removes the columns. Trades the migration added stay (they may already be in use); delete them from the
  // dashboard if you really want them gone. Approvals made automatically are not reverted.
  down: async ({ context: queryInterface }) => {
    const detailColumns = await queryInterface.describeTable(DETAILS);
    if (detailColumns.licenceVerified) await queryInterface.removeColumn(DETAILS, "licenceVerified");

    const tradeColumns = await queryInterface.describeTable(TRADES);
    if (tradeColumns.licenceLabel) await queryInterface.removeColumn(TRADES, "licenceLabel");
    if (tradeColumns.licenceRequired) await queryInterface.removeColumn(TRADES, "licenceRequired");
  },
};
