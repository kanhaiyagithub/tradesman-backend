#!/usr/bin/env node
const sequelize = require('../config/db');
const { createMigrator } = require('../database/migrator');

/**
 * Prints migration names in a stable, readable format.
 *
 * @param {Array<{ name: string }>} migrations - Migration descriptors returned by Umzug.
 * @param {string} label - Output label.
 */
const printMigrationList = (migrations, label) => {
  console.log(`\n${label}:`);

  if (!migrations.length) {
    console.log('  - none');
    return;
  }

  migrations.forEach((migration) => {
    console.log(`  - ${migration.name}`);
  });
};

/**
 * Runs the requested migration command.
 *
 * Supported commands:
 * - up: apply all pending migrations
 * - down: revert the latest migration
 * - status: show executed and pending migrations
 */
const main = async () => {
  const command = (process.argv[2] || 'up').toLowerCase();
  const migrator = createMigrator();

  try {
    if (command === 'status') {
      const [executed, pending] = await Promise.all([
        migrator.executed(),
        migrator.pending(),
      ]);

      printMigrationList(executed, 'Executed migrations');
      printMigrationList(pending, 'Pending migrations');
      return;
    }

    if (command === 'down') {
      const reverted = await migrator.down();
      console.log('\nReverted migration:', reverted?.name || 'none');
      return;
    }

    if (command !== 'up') {
      throw new Error(`Unsupported migration command: ${command}`);
    }

    const applied = await migrator.up();
    printMigrationList(applied, 'Applied migrations');
  } finally {
    await sequelize.close();
  }
};

main().catch((error) => {
  console.error('\n[DB MIGRATION ERROR]', {
    message: error.message,
    stack: error.stack,
  });
  process.exit(1);
});
