const fs = require("fs");
const path = require("path");
const sequelize = require("../config/db");
const User = require("../models/User");
const TradesmanDetails = require("../models/TradesmanDetails");

/**
 * Finds uploaded files that no database row points at any more (for example after users were deleted
 * straight from MySQL, which the API's own delete-account cleanup never sees).
 *
 * Files are matched by BASENAME, not full path: legacy rows store a bare filename, newer ones store
 * "profile/abc.jpg" or a full URL, and the generated names (category-timestamp-random.ext) are unique,
 * so the basename identifies a file regardless of how it was stored. That makes the match conservative:
 * a file is only an orphan when no row mentions its name at all.
 */

const asList = (value) => {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [value];
    } catch {
      return [value]; // a plain filename stored as text
    }
  }
  return [];
};

/** "https://x/uploads/profile/a.jpg?v=1" | "/uploads/profile/a.jpg" | "profile/a.jpg" | "a.jpg"  ->  "a.jpg" */
const toBasename = (value) => {
  if (!value || typeof value !== "string") return null;
  const withoutQuery = value.split(/[?#]/)[0].trim();
  const name = path.basename(withoutQuery.replace(/\\/g, "/"));
  return name || null;
};

/** Every filename the database still references. */
const collectReferencedBasenames = async () => {
  const names = new Set();
  const add = (value) => {
    const name = toBasename(value);
    if (name) names.add(name);
  };

  for (const user of await User.findAll({ attributes: ["profileImage"], raw: true })) {
    add(user.profileImage);
  }

  for (const row of await TradesmanDetails.findAll({
    attributes: ["licenseDocument", "portfolioPhotos"],
    raw: true,
  })) {
    add(row.licenseDocument);
    asList(row.portfolioPhotos).forEach(add);
  }

  // Legacy table that may not exist in every database.
  const tables = (await sequelize.getQueryInterface().showAllTables()).map((table) =>
    String(typeof table === "string" ? table : table.tableName),
  );
  const legacy = tables.find((table) => table.toLowerCase() === "portfoliophotos");
  if (legacy) {
    const [rows] = await sequelize.query(`SELECT \`image\` FROM \`${legacy}\``);
    rows.forEach((row) => add(row.image));
  }

  return names;
};

const walkFiles = async (dir) => {
  const found = [];
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return found;
    throw error;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await walkFiles(fullPath)));
    } else if (entry.isFile()) {
      found.push(fullPath);
    }
  }
  return found;
};

/**
 * @param {{ rootDir: string, referenced: Set<string>, minAgeMs?: number, now?: number }} params
 * @returns {Promise<{ orphans: {path: string, size: number}[], kept: number, tooNew: number }>}
 *
 * Dotfiles (.gitkeep) are never touched. Files younger than `minAgeMs` are skipped: an upload is saved
 * before its database row, so a brand-new file may simply not be referenced yet.
 */
const findOrphanFiles = async ({ rootDir, referenced, minAgeMs = 60 * 60 * 1000, now = Date.now() }) => {
  const orphans = [];
  let kept = 0;
  let tooNew = 0;

  for (const filePath of await walkFiles(rootDir)) {
    const name = path.basename(filePath);
    if (name.startsWith(".")) continue;

    if (referenced.has(name)) {
      kept += 1;
      continue;
    }

    const stats = await fs.promises.stat(filePath);
    if (now - stats.mtimeMs < minAgeMs) {
      tooNew += 1;
      continue;
    }

    orphans.push({ path: filePath, size: stats.size });
  }

  return { orphans, kept, tooNew };
};

const deleteFiles = async (files) => {
  let deleted = 0;
  const failed = [];

  for (const file of files) {
    try {
      await fs.promises.unlink(file.path);
      deleted += 1;
    } catch (error) {
      failed.push({ path: file.path, error: error.message });
    }
  }

  return { deleted, failed };
};

module.exports = { collectReferencedBasenames, findOrphanFiles, deleteFiles, toBasename };
