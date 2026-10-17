const { DataTypes } = require("sequelize");

// The initial schema creates `admins`, while the Admin model resolves to
// `Admins`; match whichever casing exists so this works on case-sensitive hosts.
const resolveAdminTable = async (queryInterface) => {
  const tables = await queryInterface.showAllTables();
  const names = tables.map((table) => (typeof table === "string" ? table : table.tableName));
  return names.find((name) => name.toLowerCase() === "admins") || null;
};

module.exports = {
  up: async ({ context: queryInterface }) => {
    const tableName = await resolveAdminTable(queryInterface);
    if (!tableName) {
      return;
    }

    const columns = await queryInterface.describeTable(tableName);

    if (!columns.resetPasswordToken) {
      await queryInterface.addColumn(tableName, "resetPasswordToken", {
        type: DataTypes.STRING,
        allowNull: true,
      });
    }

    if (!columns.resetPasswordExpires) {
      await queryInterface.addColumn(tableName, "resetPasswordExpires", {
        type: DataTypes.DATE,
        allowNull: true,
      });
    }

    if (!columns.resetPasswordAttempts) {
      await queryInterface.addColumn(tableName, "resetPasswordAttempts", {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
      });
    }
  },

  down: async ({ context: queryInterface }) => {
    const tableName = await resolveAdminTable(queryInterface);
    if (!tableName) {
      return;
    }

    const columns = await queryInterface.describeTable(tableName);

    for (const column of ["resetPasswordAttempts", "resetPasswordExpires", "resetPasswordToken"]) {
      if (columns[column]) {
        await queryInterface.removeColumn(tableName, column);
      }
    }
  },
};
