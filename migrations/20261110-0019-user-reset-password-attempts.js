const { DataTypes } = require("sequelize");

module.exports = {
  up: async ({ context: queryInterface }) => {
    const columns = await queryInterface.describeTable("Users");

    if (!columns.resetPasswordAttempts) {
      await queryInterface.addColumn("Users", "resetPasswordAttempts", {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
      });
    }
  },

  down: async ({ context: queryInterface }) => {
    const columns = await queryInterface.describeTable("Users");

    if (columns.resetPasswordAttempts) {
      await queryInterface.removeColumn("Users", "resetPasswordAttempts");
    }
  },
};
