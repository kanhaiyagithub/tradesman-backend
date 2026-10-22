#!/usr/bin/env node
/**
 * Removes uploaded files that no user, licence or portfolio row references any more.
 *
 *   npm run uploads:cleanup                    # DRY RUN: only lists what would be deleted
 *   npm run uploads:cleanup -- --delete        # actually deletes
 *   npm run uploads:cleanup -- --min-age-minutes=10
 *
 * Files newer than --min-age-minutes (default 60) are never touched, because an upload is saved
 * just before its database row. Check the database shown in the header before using --delete:
 * pointing this at the wrong database would make every file look unreferenced.
 */
require("dotenv").config();

const sequelize = require("../config/db");
const storageConfig = require("../config/storage");
const {
  collectReferencedBasenames,
  findOrphanFiles,
  deleteFiles,
} = require("../services/orphanUploadService");

const formatBytes = (bytes) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

const main = async () => {
  const args = process.argv.slice(2);
  const shouldDelete = args.includes("--delete");
  const ageArg = args.find((arg) => arg.startsWith("--min-age-minutes="));
  const minAgeMinutes = ageArg ? Number(ageArg.split("=")[1]) : 60;

  if (!Number.isFinite(minAgeMinutes) || minAgeMinutes < 0) {
    console.error("--min-age-minutes must be a number of 0 or more");
    process.exitCode = 1;
    return;
  }

  if (storageConfig.driver !== "local") {
    console.error(`STORAGE_DRIVER is "${storageConfig.driver}"; this script only cleans local uploads.`);
    process.exitCode = 1;
    return;
  }

  try {
    await sequelize.authenticate();
    const { host, database } = sequelize.config;
    console.log(`Database : ${database} @ ${host}`);
    console.log(`Uploads  : ${storageConfig.local.rootDir}`);
    console.log(`Mode     : ${shouldDelete ? "DELETE" : "dry run (nothing is deleted)"}`);

    const referenced = await collectReferencedBasenames();
    const { orphans, kept, tooNew } = await findOrphanFiles({
      rootDir: storageConfig.local.rootDir,
      referenced,
      minAgeMs: minAgeMinutes * 60 * 1000,
    });

    const totalSize = orphans.reduce((sum, file) => sum + file.size, 0);
    console.log(`\nReferenced by the database : ${referenced.size} file name(s)`);
    console.log(`Files still in use         : ${kept}`);
    console.log(`Too new to judge (skipped) : ${tooNew}`);
    console.log(`Orphans                    : ${orphans.length} (${formatBytes(totalSize)})`);

    orphans.slice(0, 20).forEach((file) => console.log(`  - ${file.path}`));
    if (orphans.length > 20) console.log(`  ... and ${orphans.length - 20} more`);

    if (!orphans.length) return;

    if (!shouldDelete) {
      console.log("\nDry run only. Re-run with --delete to remove these files.");
      return;
    }

    const { deleted, failed } = await deleteFiles(orphans);
    console.log(`\nDeleted ${deleted} file(s).`);
    if (failed.length) {
      console.error(`${failed.length} file(s) could not be deleted:`);
      failed.forEach((item) => console.error(`  - ${item.path}: ${item.error}`));
      process.exitCode = 1;
    }
  } catch (error) {
    console.error("Cleanup failed:", error.message);
    process.exitCode = 1;
  } finally {
    await sequelize.close();
  }
};

main();
