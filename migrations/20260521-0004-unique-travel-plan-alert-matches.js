/**
 * Adds a database-level uniqueness guard for travel plan/client alert matches.
 *
 * The service already checks for an existing match before insert, but this index
 * prevents duplicate rows if two API requests race each other.
 */
module.exports = {
  /**
   * Removes any historical duplicate pairs and then adds the unique index.
   *
   * @param {{ context: import('sequelize').QueryInterface }} params - Umzug migration context.
   * @returns {Promise<void>}
   */
  up: async ({ context: queryInterface }) => {
    await queryInterface.sequelize.query(`
      DELETE m1 FROM travel_plan_alert_matches m1
      INNER JOIN travel_plan_alert_matches m2
        ON m1.travelPlanId = m2.travelPlanId
       AND m1.clientTradeAlertId = m2.clientTradeAlertId
       AND m1.id > m2.id
    `);

    await queryInterface.addIndex("travel_plan_alert_matches", {
      name: "uq_travel_plan_alert_matches_plan_alert",
      unique: true,
      fields: ["travelPlanId", "clientTradeAlertId"],
    });
  },

  /**
   * Removes the uniqueness guard when rolling back this migration.
   *
   * @param {{ context: import('sequelize').QueryInterface }} params - Umzug migration context.
   * @returns {Promise<void>}
   */
  down: async ({ context: queryInterface }) => {
    await queryInterface.removeIndex(
      "travel_plan_alert_matches",
      "uq_travel_plan_alert_matches_plan_alert",
    );
  },
};
