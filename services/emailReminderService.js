const { Op } = require("sequelize");
const TravelPlanAlertMatch = require("../models/travelPlanAlertMatchModel");
const User = require("../models/User");
const { sendMatchReminderEmail } = require("./emailService");

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

function endOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function getReminderScheduleConfig() {
  const hour = Number(process.env.EMAIL_REMINDER_RUN_HOUR ?? 8);
  const minute = Number(process.env.EMAIL_REMINDER_RUN_MINUTE ?? 0);
  const runOnStart = String(process.env.EMAIL_REMINDER_RUN_ON_START || "false").toLowerCase() === "true";

  return {
    hour: Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 8,
    minute: Number.isInteger(minute) && minute >= 0 && minute <= 59 ? minute : 0,
    runOnStart,
  };
}

function getNextDailyRunDate(now = new Date(), { hour, minute }) {
  const nextRun = new Date(now);
  nextRun.setHours(hour, minute, 0, 0);

  if (nextRun <= now) {
    nextRun.setDate(nextRun.getDate() + 1);
  }

  return nextRun;
}

async function sendReminderBatch({ type, reminderLabel, targetDate }) {
  const start = startOfDay(targetDate);
  const end = endOfDay(targetDate);

  const matches = await TravelPlanAlertMatch.findAll({
    where: {
      estimatedArrivalDate: {
        [Op.between]: [start, end],
      },
      status: {
        [Op.ne]: "ignored",
      },
    },
    order: [["estimatedArrivalDate", "ASC"]],
  });

  let sent = 0;
  let skipped = 0;

  for (const match of matches) {
    try {
      const [client, tradesman] = await Promise.all([
        User.findByPk(match.clientId),
        User.findByPk(match.tradesmanId),
      ]);

      const result = await sendMatchReminderEmail({
        type,
        match,
        client,
        tradesman,
        reminderLabel,
      });

      if (result?.success && !result?.skipped) {
        sent += 1;
      } else {
        skipped += 1;
      }
    } catch (error) {
      skipped += 1;
      console.error("[EMAIL_REMINDER] Failed to send reminder", {
        type,
        matchId: match.id,
        clientId: match.clientId,
        tradesmanId: match.tradesmanId,
        error: error.message,
      });
    }
  }

  console.log("[EMAIL_REMINDER] Reminder batch completed", {
    type,
    targetDate: targetDate.toISOString(),
    totalMatches: matches.length,
    sent,
    skipped,
  });

  return { totalMatches: matches.length, sent, skipped };
}

async function runMatchReminderEmails(now = new Date()) {
  console.log("[EMAIL_REMINDER] Running match reminder email job", {
    now: now.toISOString(),
  });

  const oneDayTarget = addDays(now, 1);

  const [oneDayResult, sameDayResult] = await Promise.all([
    sendReminderBatch({
      type: "MATCH_REMINDER_1_DAY_CLIENT",
      reminderLabel: "Tomorrow",
      targetDate: oneDayTarget,
    }),
    sendReminderBatch({
      type: "MATCH_REMINDER_SAME_DAY_CLIENT",
      reminderLabel: "Today",
      targetDate: now,
    }),
  ]);

  return {
    oneDay: oneDayResult,
    sameDay: sameDayResult,
  };
}

function startMatchReminderEmailJob() {
  const scheduleConfig = getReminderScheduleConfig();
  let timer = null;
  let stopped = false;

  const scheduleNextRun = () => {
    if (stopped) {
      return null;
    }

    const now = new Date();
    const nextRun = getNextDailyRunDate(now, scheduleConfig);
    const delayMs = nextRun.getTime() - now.getTime();

    console.log("[EMAIL_REMINDER] Next match reminder email job scheduled", {
      nextRun: nextRun.toISOString(),
      serverLocalTime: nextRun.toString(),
      runHour: scheduleConfig.hour,
      runMinute: scheduleConfig.minute,
    });

    timer = setTimeout(async () => {
      try {
        await runMatchReminderEmails();
      } catch (error) {
        console.error("[EMAIL_REMINDER] Scheduled reminder job failed", error);
      } finally {
        scheduleNextRun();
      }
    }, delayMs);

    if (typeof timer.unref === "function") {
      timer.unref();
    }

    return timer;
  };

  if (scheduleConfig.runOnStart) {
    runMatchReminderEmails().catch((error) => {
      console.error("[EMAIL_REMINDER] Startup reminder job failed", error);
    });
  }

  scheduleNextRun();

  console.log("[EMAIL_REMINDER] Daily match reminder email job started", {
    runHour: scheduleConfig.hour,
    runMinute: scheduleConfig.minute,
    runOnStart: scheduleConfig.runOnStart,
    timezone: "server local timezone",
  });

  return {
    stop: () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
      }
    },
  };
}

module.exports = {
  runMatchReminderEmails,
  startMatchReminderEmailJob,
  getNextDailyRunDate,
};
