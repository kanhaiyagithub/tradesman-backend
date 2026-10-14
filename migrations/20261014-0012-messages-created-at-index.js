const tableExists = async (queryInterface, tableName) => {
  const tables = await queryInterface.showAllTables();
  return tables.some((entry) => {
    const name = typeof entry === "string" ? entry : entry.tableName || entry.table_name;
    return String(name).toLowerCase() === tableName.toLowerCase();
  });
};

const INDEX_NAME = "idx_messages_created_at";

/**
 * Index on messages.createdAt so the 30-day message cleanup can find expired
 * rows without scanning the whole table.
 */
module.exports = {
  up: async ({ context: queryInterface }) => {
    if (!(await tableExists(queryInterface, "messages"))) return;

    const indexes = await queryInterface.showIndex("messages");
    if (indexes.some((index) => index.name === INDEX_NAME)) return;

    await queryInterface.addIndex("messages", ["createdAt"], { name: INDEX_NAME });
  },

  down: async ({ context: queryInterface }) => {
    if (!(await tableExists(queryInterface, "messages"))) return;

    const indexes = await queryInterface.showIndex("messages");
    if (indexes.some((index) => index.name === INDEX_NAME)) {
      await queryInterface.removeIndex("messages", INDEX_NAME);
    }
  },
};
