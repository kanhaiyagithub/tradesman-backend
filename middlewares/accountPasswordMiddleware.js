const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const { Op } = require("sequelize");
const User = require("../models/User");
const transporter = require("../config/email");

const ACCOUNT_OTP_TTL_MS = 10 * 60 * 1000;
const ACCOUNT_OTP_PREFIX = "acct:";
const ACTIONS = { DELETE: "delete your account", CANCEL: "cancel your subscription" };

const hashOtp = (otp) => crypto.createHash("sha256").update(String(otp)).digest("hex");
const otpStorageValue = (action, otp) => `${ACCOUNT_OTP_PREFIX}${action}:${hashOtp(otp)}`;

/**
 * Re-confirms the signed-in user's identity before a destructive account
 * action (cancel subscription, delete account).
 *
 * - Accounts with a password must send it as `password` in the JSON body.
 * - Google-login accounts have no password, so they send the 6-digit `otp`
 *   emailed by POST /account-otp (single use, valid for 10 minutes).
 *
 * Runs after verifyToken. Wrong or missing credentials never reach the controller.
 */
const requireAccountPassword = (confirmWord, { onlyOwnAccountParam = null } = {}) =>
  async (req, res, next) => {
    try {
      const userId = Number(req.user?.id);
      if (!userId) {
        return res.status(401).json({ success: false, message: "Unauthorized" });
      }

      // Deleting someone else's account is rejected (or allowed for admins) by
      // the controller; only the owner has a password to confirm here.
      if (onlyOwnAccountParam && Number(req.params?.[onlyOwnAccountParam]) !== userId) {
        return next();
      }

      const user = await User.findByPk(userId);
      if (!user) {
        return res.status(404).json({ success: false, message: "User not found" });
      }

      const body = req.body || {};

      if (!user.password) {
        const otp = String(body.otp || "").trim();
        if (!/^\d{6}$/.test(otp)) {
          return res.status(400).json({
            success: false,
            message: "Enter the 6 digit code we emailed you",
            code: "OTP_REQUIRED",
          });
        }

        const valid = await User.findOne({
          where: {
            id: userId,
            resetPasswordToken: otpStorageValue(confirmWord, otp),
            resetPasswordExpires: { [Op.gt]: new Date() },
          },
        });
        if (!valid) {
          return res.status(403).json({
            success: false,
            message: "Invalid or expired code",
            code: "INVALID_OTP",
          });
        }

        // Single use.
        await user.update({ resetPasswordToken: null, resetPasswordExpires: null });
        return next();
      }

      const password = typeof body.password === "string" ? body.password : "";
      if (!password) {
        return res.status(400).json({
          success: false,
          message: "Password is required",
          code: "PASSWORD_REQUIRED",
        });
      }

      const matches = await bcrypt.compare(password, user.password);
      if (!matches) {
        return res.status(403).json({
          success: false,
          message: "Incorrect password",
          code: "INCORRECT_PASSWORD",
        });
      }

      return next();
    } catch (error) {
      console.error("Account password check error:", error);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  };

/**
 * GET /api/users/account-verification
 * Tells the app which confirmation to ask for: "password" or "otp".
 */
const getAccountVerificationMethod = async (req, res) => {
  try {
    const user = await User.findByPk(req.user?.id);
    if (!user) return res.status(404).json({ success: false, message: "User not found" });
    return res.status(200).json({
      success: true,
      message: "OK",
      data: { method: user.password ? "password" : "otp", email: user.email },
    });
  } catch (error) {
    console.error("Account verification method error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

/**
 * POST /api/users/account-otp  { action: "DELETE" | "CANCEL" }
 * Emails a 6-digit code to accounts that have no password (Google login).
 */
const sendAccountOtp = async (req, res) => {
  try {
    const action = String(req.body?.action || "").toUpperCase();
    if (!ACTIONS[action]) {
      return res.status(400).json({ success: false, message: "action must be DELETE or CANCEL" });
    }

    const user = await User.findByPk(req.user?.id);
    if (!user) return res.status(404).json({ success: false, message: "User not found" });

    if (user.password) {
      return res.status(400).json({
        success: false,
        message: "This account uses a password. Enter your password instead.",
        code: "PASSWORD_ACCOUNT",
      });
    }
    if (!user.email) {
      return res.status(400).json({ success: false, message: "No email on this account" });
    }

    const otp = String(crypto.randomInt(100000, 1000000));
    await user.update({
      resetPasswordToken: otpStorageValue(action, otp),
      resetPasswordExpires: new Date(Date.now() + ACCOUNT_OTP_TTL_MS),
    });

    const minutes = Math.floor(ACCOUNT_OTP_TTL_MS / 60000);
    const name = user.name || "there";
    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: user.email,
      subject: "Your Touring Trades confirmation code",
      text: [
        `Hi ${name},`,
        "",
        `Your code to ${ACTIONS[action]} is ${otp}.`,
        `It expires in ${minutes} minutes.`,
        "",
        "If you did not request this, ignore this email and consider changing your Google password.",
        "",
        "The Touring Trades Team",
      ].join("\n"),
    });

    return res.status(200).json({
      success: true,
      message: "A confirmation code was sent to your email",
      data: { expiresInMinutes: minutes },
    });
  } catch (error) {
    console.error("Send account OTP error:", error);
    return res.status(500).json({ success: false, message: "Could not send the code. Try again." });
  }
};

module.exports = { requireAccountPassword, getAccountVerificationMethod, sendAccountOtp };
