/**
 * Adds the travel-plan `running` enum status and removes the old cancelled
 * value from the travelplans.status enum.
 */
module.exports = {
  /**
   * Moves existing rows into the new open/running/closed lifecycle.
   *
   * @param {{ context: import('sequelize').QueryInterface }} params - Umzug migration context.
   * @returns {Promise<void>}
   */
  up: async ({ context: queryInterface }) => {
    const { sequelize } = queryInterface;

    await sequelize.query(`
      UPDATE travelplans
      SET status = 'closed'
      WHERE status = 'cancelled'
         OR (status IN ('open', 'closed') AND destinationDateTime < NOW())
    `);

    await sequelize.query(`
      ALTER TABLE travelplans
      MODIFY COLUMN status ENUM('open', 'running', 'closed') NOT NULL DEFAULT 'open'
    `);

    await sequelize.query(`
      UPDATE travelplans
      SET status = 'running'
      WHERE status = 'open'
        AND startDateTime <= NOW()
        AND destinationDateTime >= NOW()
    `);
  },

  /**
   * Restores the prior enum shape for a rollback.
   *
   * @param {{ context: import('sequelize').QueryInterface }} params - Umzug migration context.
   * @returns {Promise<void>}
   */
  down: async ({ context: queryInterface }) => {
    const { sequelize } = queryInterface;

    await sequelize.query(`
      UPDATE travelplans
      SET status = 'open'
      WHERE status = 'running'
    `);

    await sequelize.query(`
      ALTER TABLE travelplans
      MODIFY COLUMN status ENUM('open', 'closed', 'cancelled') NOT NULL DEFAULT 'open'
    `);
  },
};
