// Adds the `super_admin` role. At most one admin can hold it: a virtual generated column is 1
// for the super admin and NULL for everyone else, and carries a UNIQUE index (MySQL allows many
// NULLs but only one 1).
//
// Who becomes super admin: the admin whose email is in SUPER_ADMIN_EMAIL if that variable is set
// and matches, otherwise the earliest-created admin. Set SUPER_ADMIN_EMAIL when running this
// migration in production to pick the owner explicitly.

const KEY_COLUMN = "superAdminKey";
const KEY_INDEX = "uq_admins_single_super_admin";

// The initial schema creates `admins`, while the Admin model resolves to
// `Admins`; match whichever casing exists so this works on case-sensitive hosts.
const resolveAdminTable = async (queryInterface) => {
  const tables = await queryInterface.showAllTables();
  const names = tables.map((table) => (typeof table === "string" ? table : table.tableName));
  return names.find((name) => name.toLowerCase() === "admins") || null;
};

module.exports = {
  up: async ({ context: queryInterface }) => {
    const table = await resolveAdminTable(queryInterface);
    if (!table) return;
    const sequelize = queryInterface.sequelize;

    await sequelize.query(
      `ALTER TABLE \`${table}\` MODIFY \`role\` ENUM('admin','super_admin') NOT NULL DEFAULT 'admin'`
    );

    const columns = await queryInterface.describeTable(table);
    if (!columns[KEY_COLUMN]) {
      await sequelize.query(
        `ALTER TABLE \`${table}\` ADD COLUMN \`${KEY_COLUMN}\` TINYINT AS (IF(\`role\` = 'super_admin', 1, NULL)) VIRTUAL`
      );
    }

    const indexes = await queryInterface.showIndex(table);
    if (!indexes.some((index) => index.name === KEY_INDEX)) {
      await sequelize.query(
        `ALTER TABLE \`${table}\` ADD UNIQUE INDEX \`${KEY_INDEX}\` (\`${KEY_COLUMN}\`)`
      );
    }

    const [existing] = await sequelize.query(
      `SELECT id FROM \`${table}\` WHERE role = 'super_admin' LIMIT 1`
    );
    if (existing.length) return; // already has a super admin (migration re-run)

    const [admins] = await sequelize.query(`SELECT id, email FROM \`${table}\` ORDER BY id ASC`);
    if (!admins.length) return; // the first admin to register becomes super admin

    const wanted = String(process.env.SUPER_ADMIN_EMAIL || "").trim().toLowerCase();
    let chosen = wanted ? admins.find((a) => String(a.email).toLowerCase() === wanted) : null;
    if (wanted && !chosen) {
      console.warn(`[migration 0016] SUPER_ADMIN_EMAIL did not match any admin; using the earliest admin.`);
    }
    chosen = chosen || admins[0];

    await sequelize.query(`UPDATE \`${table}\` SET role = 'super_admin' WHERE id = :id`, {
      replacements: { id: chosen.id },
    });
  },

  down: async ({ context: queryInterface }) => {
    const table = await resolveAdminTable(queryInterface);
    if (!table) return;
    const sequelize = queryInterface.sequelize;

    const indexes = await queryInterface.showIndex(table);
    if (indexes.some((index) => index.name === KEY_INDEX)) {
      await sequelize.query(`ALTER TABLE \`${table}\` DROP INDEX \`${KEY_INDEX}\``);
    }

    const columns = await queryInterface.describeTable(table);
    if (columns[KEY_COLUMN]) {
      await sequelize.query(`ALTER TABLE \`${table}\` DROP COLUMN \`${KEY_COLUMN}\``);
    }

    await sequelize.query(`UPDATE \`${table}\` SET role = 'admin' WHERE role = 'super_admin'`);
    await sequelize.query(
      `ALTER TABLE \`${table}\` MODIFY \`role\` ENUM('admin') NOT NULL DEFAULT 'admin'`
    );
  },
};
