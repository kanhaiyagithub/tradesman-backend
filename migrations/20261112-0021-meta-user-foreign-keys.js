/**
 * Links the Meta tracking tables to Users so deleting a user cannot leave their IP, user agent and
 * device details behind: attributions are deleted with the user, events keep only their (hashed)
 * record with the user id cleared.
 */
const hasConstraint = async (queryInterface, table, name) => {
  const [rows] = await queryInterface.sequelize.query(
    `SELECT CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${table}' AND CONSTRAINT_NAME = '${name}'`
  );
  return rows.length > 0;
};

module.exports = {
  up: async ({ context: queryInterface }) => {
    // Rows of users that no longer exist would make the constraints fail: clean them first.
    await queryInterface.sequelize.query(
      "DELETE FROM meta_user_attributions WHERE userId NOT IN (SELECT id FROM Users)"
    );
    await queryInterface.sequelize.query(
      "UPDATE meta_conversion_events SET userId = NULL WHERE userId IS NOT NULL AND userId NOT IN (SELECT id FROM Users)"
    );

    if (!(await hasConstraint(queryInterface, "meta_user_attributions", "fk_meta_attributions_user"))) {
      await queryInterface.addConstraint("meta_user_attributions", {
        fields: ["userId"],
        type: "foreign key",
        name: "fk_meta_attributions_user",
        references: { table: "Users", field: "id" },
        onDelete: "CASCADE",
      });
    }

    if (!(await hasConstraint(queryInterface, "meta_conversion_events", "fk_meta_events_user"))) {
      await queryInterface.addConstraint("meta_conversion_events", {
        fields: ["userId"],
        type: "foreign key",
        name: "fk_meta_events_user",
        references: { table: "Users", field: "id" },
        onDelete: "SET NULL",
      });
    }
  },

  down: async ({ context: queryInterface }) => {
    if (await hasConstraint(queryInterface, "meta_user_attributions", "fk_meta_attributions_user")) {
      await queryInterface.removeConstraint("meta_user_attributions", "fk_meta_attributions_user");
    }
    if (await hasConstraint(queryInterface, "meta_conversion_events", "fk_meta_events_user")) {
      await queryInterface.removeConstraint("meta_conversion_events", "fk_meta_events_user");
    }
  },
};
