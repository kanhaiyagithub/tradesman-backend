const nodemailer = require("nodemailer");
const EmailNotificationLog = require("../models/EmailNotificationLog");

function getSmtpPassword() {
  return (process.env.SMTP_PASS || "").replace(/\s+/g, "");
}

function isEmailConfigured() {
  return Boolean(
    process.env.SMTP_HOST &&
      process.env.SMTP_PORT &&
      process.env.SMTP_USER &&
      getSmtpPassword() &&
      process.env.SMTP_FROM,
  );
}

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: String(process.env.SMTP_SECURE).toLowerCase() === "true",
  auth: {
    user: process.env.SMTP_USER,
    pass: getSmtpPassword(),
  },
});

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatDate(value) {
  if (!value) return "Not specified";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not specified";
  return date.toLocaleString("en-AU", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: process.env.EMAIL_TIMEZONE || "Australia/Sydney",
  });
}

function buildBaseTemplate({ title, intro, details = [] }) {
  const detailRows = details
    .filter((item) => item && item.label && item.value !== undefined && item.value !== null && item.value !== "")
    .map(
      (item) => `
        <tr>
          <td style="padding:8px 0;color:#6b7280;width:140px;">${escapeHtml(item.label)}</td>
          <td style="padding:8px 0;color:#111827;font-weight:600;">${escapeHtml(item.value)}</td>
        </tr>
      `,
    )
    .join("");

  return `
    <div style="font-family:Arial,sans-serif;background:#f8f5ee;padding:24px;">
      <div style="max-width:620px;margin:0 auto;background:#ffffff;border-radius:12px;padding:24px;border:1px solid #eadfca;">
        <h2 style="margin:0 0 12px;color:#3b2e1e;">${escapeHtml(title)}</h2>
        <p style="font-size:15px;line-height:1.6;color:#374151;">${escapeHtml(intro)}</p>
        ${detailRows ? `<table style="width:100%;border-collapse:collapse;margin:16px 0;">${detailRows}</table>` : ""}
        <p style="font-size:15px;line-height:1.6;color:#374151;">Open the Touring Trades app to view details and continue the conversation.</p>
        <p style="font-size:13px;color:#6b7280;margin-top:24px;">Regards,<br/>Touring Trades</p>
      </div>
    </div>
  `;
}

const sendMail = async ({ to, subject, html }) => {
  if (!to) {
    return { success: false, reason: "EMAIL_RECIPIENT_MISSING" };
  }

  if (!isEmailConfigured()) {
    console.log("[EMAIL] SMTP is not fully configured, skipping email", {
      to,
      subject,
      smtpHost: process.env.SMTP_HOST || null,
      smtpUserExists: Boolean(process.env.SMTP_USER),
      smtpPassLength: getSmtpPassword().length,
    });
    return { success: false, reason: "SMTP_NOT_CONFIGURED" };
  }

  console.log("[EMAIL] Sending email", {
    to,
    subject,
    from: process.env.SMTP_FROM,
    smtpUser: process.env.SMTP_USER,
  });

  try {
    const info = await transporter.sendMail({
      from: process.env.SMTP_FROM,
      to,
      subject,
      html,
    });

    console.log("[EMAIL] Email sent", {
      to,
      subject,
      messageId: info.messageId,
    });

    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error("[EMAIL] Email failed", {
      to,
      subject,
      code: error.code,
      command: error.command,
      responseCode: error.responseCode,
      response: error.response,
      message: error.message,
    });

    return { success: false, reason: error.message, error };
  }
};

async function sendLoggedEmail({
  type,
  recipientUser,
  recipientEmail,
  subject,
  html,
  travelPlanId = null,
  clientTradeAlertId = null,
  matchId = null,
  clientId = null,
  tradesmanId = null,
}) {
  const to = recipientEmail || recipientUser?.email;
  const recipientUserId = recipientUser?.id || null;

  if (!to) {
    console.log("[EMAIL] Recipient email missing, skipping logged email", {
      type,
      travelPlanId,
      clientTradeAlertId,
      matchId,
      recipientUserId,
    });
    return { success: false, reason: "EMAIL_RECIPIENT_MISSING" };
  }

  const existing = await EmailNotificationLog.findOne({
    where: {
      type,
      travelPlanId,
      clientTradeAlertId,
      recipientUserId,
    },
  });

  if (existing && existing.status === "sent") {
    console.log("[EMAIL] Duplicate email skipped", {
      type,
      travelPlanId,
      clientTradeAlertId,
      matchId,
      recipientUserId,
      existingLogId: existing.id,
      status: existing.status,
    });
    return { success: true, skipped: true, reason: "ALREADY_SENT" };
  }

  const result = await sendMail({ to, subject, html });

  try {
    const payload = {
      type,
      travelPlanId,
      clientTradeAlertId,
      matchId,
      clientId,
      tradesmanId,
      recipientUserId,
      recipientEmail: to,
      status: result.success ? "sent" : "failed",
      errorMessage: result.success ? null : String(result.reason || "Email failed").slice(0, 1000),
      sentAt: result.success ? new Date() : null,
    };

    if (existing) {
      await existing.update(payload);
    } else {
      await EmailNotificationLog.create(payload);
    }
  } catch (error) {
    console.error("[EMAIL] Failed to create/update email log", {
      type,
      travelPlanId,
      clientTradeAlertId,
      matchId,
      recipientUserId,
      error: error.message,
    });
  }

  return result;
}

async function sendTravelMatchCreatedEmails({ match, alert, travelPlan, client, tradesman }) {
  const commonDetails = [
    { label: "Matched location", value: match.matchedStopName || alert.locationName },
    { label: "Client alert", value: alert.locationName },
    { label: "Expected arrival", value: formatDate(match.estimatedArrivalDate) },
    { label: "Distance", value: match.matchedDistanceKm ? `${match.matchedDistanceKm} km` : null },
  ];

  await sendLoggedEmail({
    type: "MATCH_CREATED_CLIENT",
    recipientUser: client,
    subject: "New travel match found",
    html: buildBaseTemplate({
      title: "New travel match found",
      intro: `${tradesman?.name || "A tradesman"} has a travel plan that matches your trade alert.`,
      details: [
        { label: "Tradesman", value: tradesman?.name },
        ...commonDetails,
      ],
    }),
    travelPlanId: travelPlan.id,
    clientTradeAlertId: alert.id,
    matchId: match.id,
    clientId: alert.clientId,
    tradesmanId: travelPlan.tradesmanId,
  });

  await sendLoggedEmail({
    type: "MATCH_CREATED_TRADESMAN",
    recipientUser: tradesman,
    subject: "A client alert matches your travel plan",
    html: buildBaseTemplate({
      title: "A client alert matches your travel plan",
      intro: `${client?.name || "A client"} has a trade alert that matches your travel route.`,
      details: [
        { label: "Client", value: client?.name },
        ...commonDetails,
      ],
    }),
    travelPlanId: travelPlan.id,
    clientTradeAlertId: alert.id,
    matchId: match.id,
    clientId: alert.clientId,
    tradesmanId: travelPlan.tradesmanId,
  });
}

async function sendTradesmanEnteredRadiusEmail({ alert, travelPlan, client, tradesman, distanceKm }) {
  return sendLoggedEmail({
    type: "TRADESMAN_ENTERED_RADIUS_CLIENT",
    recipientUser: client,
    subject: "Matched tradesman is nearby now",
    html: buildBaseTemplate({
      title: "Matched tradesman is nearby now",
      intro: `${tradesman?.name || "A matched tradesman"} is now inside your requested radius.`,
      details: [
        { label: "Tradesman", value: tradesman?.name },
        { label: "Client alert", value: alert.locationName },
        { label: "Distance", value: distanceKm !== undefined && distanceKm !== null ? `${distanceKm} km` : null },
      ],
    }),
    travelPlanId: travelPlan.id,
    clientTradeAlertId: alert.id,
    clientId: alert.clientId,
    tradesmanId: travelPlan.tradesmanId,
  });
}

async function sendMatchReminderEmail({ type, match, client, tradesman, reminderLabel }) {
  return sendLoggedEmail({
    type,
    recipientUser: client,
    subject: `Travel match reminder: ${reminderLabel}`,
    html: buildBaseTemplate({
      title: `Travel match reminder: ${reminderLabel}`,
      intro: `${tradesman?.name || "A matched tradesman"} is scheduled to be near your matched location ${reminderLabel.toLowerCase()}.`,
      details: [
        { label: "Tradesman", value: tradesman?.name },
        { label: "Matched location", value: match.matchedStopName },
        { label: "Expected arrival", value: formatDate(match.estimatedArrivalDate) },
        { label: "Distance", value: match.matchedDistanceKm ? `${match.matchedDistanceKm} km` : null },
      ],
    }),
    travelPlanId: match.travelPlanId,
    clientTradeAlertId: match.clientTradeAlertId,
    matchId: match.id,
    clientId: match.clientId,
    tradesmanId: match.tradesmanId,
  });
}

module.exports = {
  sendMail,
  sendLoggedEmail,
  sendTravelMatchCreatedEmails,
  sendTradesmanEnteredRadiusEmail,
  sendMatchReminderEmail,
};
