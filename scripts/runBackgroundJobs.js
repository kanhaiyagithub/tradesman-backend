#!/usr/bin/env node
const dotenv = require("dotenv");
dotenv.config();

const sequelize = require("../config/db");
const { startBackgroundJobs } = require("../services/backgroundJobRunner");

let jobs = null;

const shutdown = async (signal) => {
  console.log("[BACKGROUND_JOBS] Shutting down", { signal });

  if (jobs) {
    jobs.stop();
  }

  await sequelize.close();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function main() {
  await sequelize.authenticate();
  jobs = startBackgroundJobs();

  console.log("[BACKGROUND_JOBS] Worker started", {
    pid: process.pid,
    at: new Date().toISOString(),
  });
}

main().catch(async (error) => {
  console.error("[BACKGROUND_JOBS] Worker failed to start", {
    message: error.message,
    stack: error.stack,
  });

  await sequelize.close();
  process.exit(1);
});
