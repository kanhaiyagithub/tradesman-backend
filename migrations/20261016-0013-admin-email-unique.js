// The initial schema creates `admins`, while the Admin model resolves to
// `Admins`; match whichever casing exists so this works on case-sensitive hosts.
const resolveAdminTable = async (queryInterface) => {
  const tables = await queryInterface.showAllTables();
  const names = tables.map((table) => (typeof table === "string" ? table : table.tableName));
  return names.find((name) => name.toLowerCase() === "admins") || null;
};

const getIndexNames = async (queryInterface, tableName) => {
  const indexes = await queryInterface.showIndex(tableName);
  return new Set(indexes.map((index) => index.name));
};

const ensureNoDuplicateEmails = async (queryInterface, tableName) => {
  const [duplicates] = await queryInterface.sequelize.query(`
    SELECT LOWER(email) AS email, COUNT(*) AS count
    FROM \`${tableName}\`
    GROUP BY LOWER(email)
    HAVING COUNT(*) > 1
  `);

  if (duplicates.length) {
    const emails = duplicates.map((row) => row.email).join(", ");
    throw new Error(
      `Cannot add unique admin email index until duplicate emails are resolved: ${emails}`
    );
  }
};

module.exports = {
  up: async ({ context: queryInterface }) => {
    const tableName = await resolveAdminTable(queryInterface);
    if (!tableName) {
      return;
    }

    await ensureNoDuplicateEmails(queryInterface, tableName);

    const indexNames = await getIndexNames(queryInterface, tableName);
    if (indexNames.has("uq_admins_email")) {
      return;
    }

    await queryInterface.addIndex(tableName, {
      name: "uq_admins_email",
      unique: true,
      fields: ["email"],
    });
  },

  down: async ({ context: queryInterface }) => {
    const tableName = await resolveAdminTable(queryInterface);
    if (!tableName) {
      return;
    }

    const indexNames = await getIndexNames(queryInterface, tableName);
    if (indexNames.has("uq_admins_email")) {
      await queryInterface.removeIndex(tableName, "uq_admins_email");
    }
  },
};
