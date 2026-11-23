const { DataTypes } = require("sequelize");

module.exports = {
  up: async ({ context: queryInterface }) => {
    const columns = await queryInterface.describeTable("user_subscriptions");

    if (!columns.trialUsedAt) {
      await queryInterface.addColumn("user_subscriptions", "trialUsedAt", {
        type: DataTypes.DATE,
        allowNull: true,
      });
    }

    // Anyone who already had a trial must not get another one.
    await queryInterface.sequelize.query(
      "UPDATE user_subscriptions SET trialUsedAt = trialEndsAt WHERE trialUsedAt IS NULL AND trialEndsAt IS NOT NULL"
    );
  },

  down: async ({ context: queryInterface }) => {
    const columns = await queryInterface.describeTable("user_subscriptions");

    if (columns.trialUsedAt) {
      await queryInterface.removeColumn("user_subscriptions", "trialUsedAt");
    }
  },
};
