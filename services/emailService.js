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

function formatDay(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("en-AU", {
    dateStyle: "long",
    timeZone: process.env.EMAIL_TIMEZONE || "Australia/Sydney",
  });
}

function formatMoney(amount, currency) {
  const code = String(currency || "").toUpperCase();
  try {
    return new Intl.NumberFormat("en-AU", { style: "currency", currency: code }).format(amount);
  } catch (error) {
    return `${Number(amount).toFixed(2)} ${code}`.trim();
  }
}

function buildBaseTemplate({
  title,
  intro,
  details = [],
  footer = "Open the Touring Trades app to view details and continue the conversation.",
}) {
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
        <p style="font-size:15px;line-height:1.6;color:#374151;">${escapeHtml(footer)}</p>
        <p style="font-size:13px;color:#6b7280;margin-top:24px;">Regards,<br/>Touring Trades</p>
      </div>
    </div>
  `;
}

const sendMail = async ({ to, subject, html, text }) => {
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
      ...(text ? { text } : {}),
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
  text,
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

  const result = await sendMail({ to, subject, html, text });

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

/* ===========================
   SUBSCRIPTION EMAILS
   =========================== */

const SUBSCRIPTION_EMAIL_TIMEOUT_MS = 8000;

function subscriptionEmailsEnabled() {
  return String(process.env.SUBSCRIPTION_EMAILS_ENABLED ?? "true").trim().toLowerCase() !== "false";
}

/**
 * The ONE entry point for subscription emails. It never throws: the switch,
 * missing recipient, SMTP, database and timeout problems are all caught and
 * logged, so an email problem can never fail or retry a Stripe webhook.
 *
 * `type` doubles as the once-only key (it includes the Stripe subscription or
 * invoice id), and sendLoggedEmail skips a type that was already sent to the
 * same user. That is what stops a re-delivered or retried webhook from sending
 * a second email.
 */
async function sendSubscriptionEmail({ type, user, subject, text, html }) {
  try {
    if (!subscriptionEmailsEnabled()) {
      return { success: false, skipped: true, reason: "SUBSCRIPTION_EMAILS_DISABLED" };
    }

    if (!user || !user.email) {
      console.log("[EMAIL] Subscription email skipped, user has no email", { type });
      return { success: false, skipped: true, reason: "EMAIL_RECIPIENT_MISSING" };
    }

    const timeoutMs = Number(process.env.SUBSCRIPTION_EMAIL_TIMEOUT_MS) || SUBSCRIPTION_EMAIL_TIMEOUT_MS;
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ success: false, reason: "EMAIL_TIMEOUT" }), timeoutMs);
    });

    try {
      return await Promise.race([
        sendLoggedEmail({
          type: String(type).slice(0, 80),
          recipientUser: user,
          subject,
          html,
          text,
        }),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    console.error("[EMAIL] Subscription email failed", { type, error: error.message });
    return { success: false, reason: error.message };
  }
}

const greeting = (user) => `Hi ${user?.name || "there"},`;

async function sendSubscriptionWelcomeEmail({ user, stripeSubscriptionId, planName, amount, currency, renewalDate }) {
  const price = formatMoney(amount, currency);
  const renewal = formatDay(renewalDate);
  const subject = "Welcome to Touring Trades - thank you for subscribing";

  const lines = [
    greeting(user),
    `Thank you for subscribing to the ${planName} plan. Your first payment of ${price} was received.`,
    renewal ? `Your plan renews on ${renewal}.` : null,
    "Open the Touring Trades app to start using your plan.",
    "Regards,\nTouring Trades",
  ].filter(Boolean);

  return sendSubscriptionEmail({
    type: `SUBSCRIPTION_WELCOME:${stripeSubscriptionId}`,
    user,
    subject,
    text: lines.join("\n\n"),
    html: buildBaseTemplate({
      title: "Thank you for subscribing",
      intro: `${greeting(user)} Thank you for subscribing to the ${planName} plan. Your first payment was received.`,
      details: [
        { label: "Plan", value: planName },
        { label: "Amount", value: price },
        { label: "Renews on", value: renewal },
      ],
      footer: "Open the Touring Trades app to start using your plan.",
    }),
  });
}

async function sendSubscriptionPaymentFailedEmail({ user, stripeSubscriptionId, invoiceId, attemptCount, nextAttemptDate }) {
  const nextAttempt = formatDay(nextAttemptDate);
  const subject = "Action needed: your Touring Trades payment failed";

  const lines = [
    greeting(user),
    "We couldn't process your latest subscription payment. Please update your card.",
    "Your access continues while Stripe retries the payment" +
      (nextAttempt ? `; the next attempt is expected on ${nextAttempt}.` : ".") +
      " If it keeps failing, your subscription may end.",
    "To update your card, open the Touring Trades app and tap the payment notification.",
    "Regards,\nTouring Trades",
  ];

  return sendSubscriptionEmail({
    type: `SUBSCRIPTION_PAYMENT_FAILED:${invoiceId || stripeSubscriptionId}:${attemptCount || 0}`,
    user,
    subject,
    text: lines.join("\n\n"),
    html: buildBaseTemplate({
      title: "Your payment failed",
      intro: `${greeting(user)} We couldn't process your latest subscription payment. Please update your card. Your access continues while Stripe retries the payment${nextAttempt ? `; the next attempt is expected on ${nextAttempt}` : ""}. If it keeps failing, your subscription may end.`,
      footer: "To update your card, open the Touring Trades app and tap the payment notification.",
    }),
  });
}

async function sendSubscriptionCancelScheduledEmail({ user, stripeSubscriptionId, endDate }) {
  const end = formatDay(endDate);
  const endUnix = endDate ? Math.floor(new Date(endDate).getTime() / 1000) : 0;
  const subject = "Your Touring Trades cancellation is scheduled";

  const lines = [
    greeting(user),
    end
      ? `Your subscription is set to cancel. You will keep full access until ${end}.`
      : "Your subscription is set to cancel at the end of the current billing period. You will keep full access until then.",
    "Changed your mind? You can keep your plan from the Touring Trades app before it ends.",
    "Regards,\nTouring Trades",
  ];

  return sendSubscriptionEmail({
    type: `SUBSCRIPTION_CANCEL_SCHEDULED:${stripeSubscriptionId}:${endUnix}`,
    user,
    subject,
    text: lines.join("\n\n"),
    html: buildBaseTemplate({
      title: "Your cancellation is scheduled",
      intro: `${greeting(user)} ${lines[1]}`,
      details: [{ label: "Access ends", value: end }],
      footer: "Changed your mind? You can keep your plan from the Touring Trades app before it ends.",
    }),
  });
}

async function sendSubscriptionEndedEmail({ user, stripeSubscriptionId }) {
  const subject = "Your Touring Trades plan has ended";

  const lines = [
    greeting(user),
    "Your Touring Trades plan has ended, so your subscription features are no longer available.",
    "You can resubscribe at any time in the Touring Trades app.",
    "Regards,\nTouring Trades",
  ];

  return sendSubscriptionEmail({
    type: `SUBSCRIPTION_ENDED:${stripeSubscriptionId}`,
    user,
    subject,
    text: lines.join("\n\n"),
    html: buildBaseTemplate({
      title: "Your plan has ended",
      intro: `${greeting(user)} ${lines[1]}`,
      footer: "You can resubscribe at any time in the Touring Trades app.",
    }),
  });
}

module.exports = {
  sendMail,
  sendLoggedEmail,
  sendSubscriptionEmail,
  sendSubscriptionWelcomeEmail,
  sendSubscriptionPaymentFailedEmail,
  sendSubscriptionCancelScheduledEmail,
  sendSubscriptionEndedEmail,
  sendTravelMatchCreatedEmails,
  sendTradesmanEnteredRadiusEmail,
  sendMatchReminderEmail,
};
