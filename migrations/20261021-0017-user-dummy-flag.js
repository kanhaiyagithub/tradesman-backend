const { DataTypes } = require("sequelize");

const TABLE = "Users";
const INDEX = "idx_users_is_dummy";

// Adds Users.isDummy: accounts an admin creates from the dashboard for testing. They are kept out of
// real statistics and never mix with real users. Every existing user stays a real one (false).
module.exports = {
  up: async ({ context: queryInterface }) => {
    const columns = await queryInterface.describeTable(TABLE);

    if (!columns.isDummy) {
      await queryInterface.addColumn(TABLE, "isDummy", {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      });
    }

    const indexes = await queryInterface.showIndex(TABLE);
    if (!indexes.some((index) => index.name === INDEX)) {
      await queryInterface.addIndex(TABLE, { name: INDEX, fields: ["isDummy"] });
    }
  },

  down: async ({ context: queryInterface }) => {
    const indexes = await queryInterface.showIndex(TABLE);
    if (indexes.some((index) => index.name === INDEX)) {
      await queryInterface.removeIndex(TABLE, INDEX);
    }

    const columns = await queryInterface.describeTable(TABLE);
    if (columns.isDummy) {
      await queryInterface.removeColumn(TABLE, "isDummy");
    }
  },
};
