const getIndexNames = async (queryInterface, tableName) => {
  const indexes = await queryInterface.showIndex(tableName);
  return new Set(indexes.map((index) => index.name));
};

const ensureNoDuplicateEmails = async (queryInterface) => {
  const [duplicates] = await queryInterface.sequelize.query(`
    SELECT LOWER(email) AS email, COUNT(*) AS count
    FROM Users
    GROUP BY LOWER(email)
    HAVING COUNT(*) > 1
  `);

  if (duplicates.length) {
    const emails = duplicates.map((row) => row.email).join(", ");
    throw new Error(
      `Cannot add unique user email index until duplicate emails are resolved: ${emails}`
    );
  }
};

module.exports = {
  up: async ({ context: queryInterface }) => {
    await ensureNoDuplicateEmails(queryInterface);

    const indexNames = await getIndexNames(queryInterface, "Users");
    if (indexNames.has("uq_users_email")) {
      return;
    }

    await queryInterface.addIndex("Users", {
      name: "uq_users_email",
      unique: true,
      fields: ["email"],
    });
  },

  down: async ({ context: queryInterface }) => {
    const indexNames = await getIndexNames(queryInterface, "Users");
    if (indexNames.has("uq_users_email")) {
      await queryInterface.removeIndex("Users", "uq_users_email");
    }
  },
};
