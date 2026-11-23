const { Op } = require("sequelize");

const MetaConversionEvent = require("../models/MetaConversionEvent");
const metaConversionService = require("./metaConversionService");
const { withJobLock } = require("./backgroundJobLockService");

/**
 * Keeps Meta tracking healthy without anyone remembering to run scripts:
 *  - every few minutes re-sends failed events and events stuck as "pending"
 *    (a deploy or restart can interrupt a send), so none are lost;
 *  - about once a day deletes events older than the retention period (they carry
 *    hashed identifiers, IP and user agent, and are never retried after 6 days).
 */

const META_MAINTENANCE_LOCK = "tradesman:meta-maintenance";
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const PURGE_EVERY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 30;

const getRetentionDays = () => {
  const value = Number(process.env.META_EVENT_RETENTION_DAYS);
  return Number.isFinite(value) && value >= 7 ? value : DEFAULT_RETENTION_DAYS;
};

/** Deletes events older than the retention period. Returns how many were removed. */
const purgeOldEvents = async (now = new Date()) => {
  const cutoff = new Date(now.getTime() - getRetentionDays() * 24 * 60 * 60 * 1000);
  return MetaConversionEvent.destroy({ where: { createdAt: { [Op.lt]: cutoff } } });
};

let lastPurgeAt = 0;

const runMetaMaintenance = async () => {
  const lockResult = await withJobLock(META_MAINTENANCE_LOCK, async () => {
    const retried = await metaConversionService.retryPendingEvents();

    let purged = 0;
    if (Date.now() - lastPurgeAt >= PURGE_EVERY_MS) {
      purged = await purgeOldEvents();
      lastPurgeAt = Date.now();
    }

    return { retried, purged };
  });

  if (lockResult.skipped) return lockResult;

  const { retried, purged } = lockResult.result;
  if (retried.attempted > 0 || purged > 0) {
    console.log("[META_MAINTENANCE] Completed", lockResult.result);
  }
  return lockResult.result;
};

/** Starts the every-5-minutes loop. Returns { stop }. */
const startMetaMaintenanceJob = () => {
  const intervalMs = Number(process.env.META_MAINTENANCE_INTERVAL_MS) || DEFAULT_INTERVAL_MS;

  const safeRun = async () => {
    try {
      await runMetaMaintenance();
    } catch (error) {
      console.error("[META_MAINTENANCE] Job failed", error.message);
    }
  };

  const timer = setInterval(safeRun, intervalMs);
  if (typeof timer.unref === "function") timer.unref();

  return { stop: () => clearInterval(timer) };
};

module.exports = {
  purgeOldEvents,
  runMetaMaintenance,
  startMetaMaintenanceJob,
};
