/**
 * Adds a database-level uniqueness guard so each user can review a hire only once.
 *
 * This allows both directions for the same hire:
 * - client -> tradesman
 * - tradesman -> client
 *
 * But prevents the same reviewer from submitting duplicate reviews for the same hire.
 */
module.exports = {
  up: async ({ context: queryInterface }) => {
    await queryInterface.sequelize.query(`
      DELETE r1 FROM reviews r1
      INNER JOIN reviews r2
        ON r1.hireId = r2.hireId
       AND r1.fromUserId = r2.fromUserId
       AND r1.id > r2.id
    `);

    await queryInterface.addIndex("reviews", {
      name: "uq_reviews_hire_reviewer",
      unique: true,
      fields: ["hireId", "fromUserId"],
    });
  },

  down: async ({ context: queryInterface }) => {
    await queryInterface.removeIndex("reviews", "uq_reviews_hire_reviewer");
  },
};
