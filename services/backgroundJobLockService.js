const sequelize = require("../config/db");

const localLocks = new Set();

const isMysqlDialect = () => sequelize.getDialect && sequelize.getDialect() === "mysql";

const acquireMysqlLock = async (lockName, timeoutSeconds) => {
  const [rows] = await sequelize.query("SELECT GET_LOCK(:lockName, :timeoutSeconds) AS acquired", {
    replacements: { lockName, timeoutSeconds },
  });

  return Number(rows?.[0]?.acquired) === 1;
};

const releaseMysqlLock = async (lockName) => {
  await sequelize.query("SELECT RELEASE_LOCK(:lockName)", {
    replacements: { lockName },
  });
};

async function withJobLock(lockName, task, options = {}) {
  const timeoutSeconds = Number(options.timeoutSeconds ?? 0);

  if (isMysqlDialect()) {
    const acquired = await acquireMysqlLock(lockName, timeoutSeconds);
    if (!acquired) {
      return {
        skipped: true,
        reason: "LOCK_NOT_ACQUIRED",
      };
    }

    try {
      const result = await task();
      return {
        skipped: false,
        result,
      };
    } finally {
      await releaseMysqlLock(lockName);
    }
  }

  if (localLocks.has(lockName)) {
    return {
      skipped: true,
      reason: "LOCAL_LOCK_ACTIVE",
    };
  }

  localLocks.add(lockName);
  try {
    const result = await task();
    return {
      skipped: false,
      result,
    };
  } finally {
    localLocks.delete(lockName);
  }
}

module.exports = {
  withJobLock,
};
