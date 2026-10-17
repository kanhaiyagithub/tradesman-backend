const { DataTypes } = require("sequelize");

const TABLE = "TradesmanDetails";

const STATUSES = ["pending", "approved", "rejected", "resubmitted"];

module.exports = {
  up: async ({ context: queryInterface }) => {
    const columns = await queryInterface.describeTable(TABLE);

    if (!columns.verificationStatus) {
      await queryInterface.addColumn(TABLE, "verificationStatus", {
        type: DataTypes.ENUM(...STATUSES),
        allowNull: false,
        defaultValue: "pending",
      });
    }
    if (!columns.submittedAt) {
      await queryInterface.addColumn(TABLE, "submittedAt", {
        type: DataTypes.DATE,
        allowNull: true,
      });
    }
    if (!columns.resubmittedAt) {
      await queryInterface.addColumn(TABLE, "resubmittedAt", {
        type: DataTypes.DATE,
        allowNull: true,
      });
    }

    // Backfill from the legacy isApproved / rejectionReason pair.
    await queryInterface.sequelize.query(
      `UPDATE \`${TABLE}\` SET verificationStatus = 'approved' WHERE isApproved = 1`
    );
    await queryInterface.sequelize.query(
      `UPDATE \`${TABLE}\` SET verificationStatus = 'rejected'
       WHERE isApproved = 0 AND rejectionReason IS NOT NULL AND rejectionReason <> ''`
    );
    await queryInterface.sequelize.query(
      `UPDATE \`${TABLE}\` SET submittedAt = createdAt WHERE submittedAt IS NULL`
    );

    const indexes = await queryInterface.showIndex(TABLE);
    if (!indexes.some((index) => index.name === "idx_tradesmandetails_verification_status")) {
      await queryInterface.addIndex(TABLE, {
        name: "idx_tradesmandetails_verification_status",
        fields: ["verificationStatus"],
      });
    }
  },

  down: async ({ context: queryInterface }) => {
    const indexes = await queryInterface.showIndex(TABLE);
    if (indexes.some((index) => index.name === "idx_tradesmandetails_verification_status")) {
      await queryInterface.removeIndex(TABLE, "idx_tradesmandetails_verification_status");
    }

    const columns = await queryInterface.describeTable(TABLE);
    for (const column of ["resubmittedAt", "submittedAt", "verificationStatus"]) {
      if (columns[column]) {
        await queryInterface.removeColumn(TABLE, column);
      }
    }
  },
};
