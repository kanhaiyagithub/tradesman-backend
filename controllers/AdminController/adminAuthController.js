const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { Op } = require('sequelize');
const Admin = require('../../models/AdminModel/adminModel');
const { sendAdminPasswordResetOtpEmail } = require('../../services/emailService');

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;
const RESET_OTP_TTL_MS = 10 * 60 * 1000;
const RESET_TOKEN_TTL_MS = 15 * 60 * 1000;
const MAX_OTP_ATTEMPTS = 5;
const RESET_OTP_PREFIX = 'otp:';
const RESET_TOKEN_PREFIX = 'reset:';

const normalizeEmail = (email) => String(email || '').trim().toLowerCase();
const hashSecret = (value) =>
    crypto.createHash('sha256').update(String(value)).digest('hex');
const clearResetState = {
    resetPasswordToken: null,
    resetPasswordExpires: null,
    resetPasswordAttempts: 0,
};

// Admin sessions are short: there is no refresh token, so after this long the admin signs in again.
// (Deleting an admin still cuts their access immediately; this only limits a stolen token.)
const ADMIN_TOKEN_TTL = '1d';

const signToken =(admin) => {
    // The claim only says "this is an admin token". Super-admin status is read from the
    // database on every request (verifyAdminToken), so it can change without re-login.
    return jwt.sign(
        { id: admin.id, role: 'admin' },
        process.env.JWT_SECRET,
        { expiresIn: ADMIN_TOKEN_TTL }
    );
};

const bootstrapFirstAdmin = async (req, res) => {
    const { name, email, password } = req.body || {};

    if (typeof email !== 'string' || !EMAIL_PATTERN.test(email.trim())) {
        return res.status(400).json({ success: false, message: 'A valid email is required' });
    }
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
        return res.status(400).json({
            success: false,
            message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
        });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const displayName =
        typeof name === 'string' && name.trim() ? name.trim() : normalizedEmail.split('@')[0];

    // The very first admin is the super admin. If two first logins race, the database's
    // single-super-admin unique index rejects the second one.
    let admin;
    try {
        admin = await Admin.create({
            name: displayName,
            email: normalizedEmail,
            password: await bcrypt.hash(password, 10),
            role: 'super_admin',
        });
    } catch (error) {
        if (error.name === 'SequelizeUniqueConstraintError') {
            return res.status(400).json({ success: false, message: 'Invalid credentials' });
        }
        throw error;
    }

    // Two simultaneous first logins with different emails could both pass the
    // empty-table check; only the earliest-created admin survives.
    const earlier = await Admin.findOne({ where: { id: { [Op.lt]: admin.id } } });
    if (earlier) {
        await admin.destroy();
        return res.status(400).json({ success: false, message: 'Invalid credentials' });
    }

    const token = signToken(admin);
    return res.status(201).json({
        success: true,
        message: 'First admin account created',
        data: {
            token,
            registered: true,
            admin: { id: admin.id, name: admin.name, email: admin.email },
        },
    });
};

exports.login = async (req, res) => {
    try {
      const { email, password } = req.body || {};

      // No admin exists yet: the first login attempt registers the first admin.
      if ((await Admin.count()) === 0) {
        return await bootstrapFirstAdmin(req, res);
      }

      const admin = await Admin.findOne({ where: { email } });
      if (!admin) return res.status(400).json({ success:false, message:'Invalid credentials' });

      const isMatch = await bcrypt.compare(password, admin.password);
      if (!isMatch) return res.status(400).json({ success:false, message:'Invalid credentials' });

      const token = signToken(admin);
      return res.json({ success:true, data:{ token, admin: { id: admin.id, name: admin.name, email: admin.email } } });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ success:false, message:'Server error' });
    }
  };

exports.registerAdmin = async (req, res) => {
    try {
        const { name, email, password, adminPassword } = req.body || {};

        // A signed-in super admin must confirm with their OWN password (`adminPassword`; not the
        // new admin's `password`). Skipped only for the very first admin, who has no one to confirm.
        // Wrong or missing is a 400, not 401, so the dashboard does not treat it as an expired session.
        if (req.user) {
            if (typeof adminPassword !== 'string' || !adminPassword) {
                return res.status(400).json({ message: 'Your password is required to add an admin' });
            }
            const actingAdmin = await Admin.findByPk(req.user.id);
            if (!actingAdmin || !(await bcrypt.compare(adminPassword, actingAdmin.password))) {
                return res.status(400).json({ message: 'Incorrect password' });
            }
        }

        if (typeof name !== 'string' || !name.trim()) {
            return res.status(400).json({ message: 'Name is required' });
        }
        if (typeof email !== 'string' || !EMAIL_PATTERN.test(email.trim())) {
            return res.status(400).json({ message: 'A valid email is required' });
        }
        if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
            return res.status(400).json({
                message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
            });
        }

        const normalizedEmail = email.trim().toLowerCase();

        const existing = await Admin.findOne({ where: { email: normalizedEmail } });
        if (existing) {
            return res.status(400).json({ message: 'Admin already exists' });
        }

        const hashed = await bcrypt.hash(password, 10);
        // Only the super admin can reach this route (see adminRoutes), except when no admin
        // exists yet: then the account being created is the first, and becomes super admin.
        const isFirstAdmin = (await Admin.count()) === 0;
        const admin = await Admin.create({
            name: name.trim(),
            email: normalizedEmail,
            password: hashed,
            role: isFirstAdmin ? 'super_admin' : 'admin',
        });

        res.status(201).json({
            message: 'Admin created successfully',
            admin: {
                id: admin.id,
                name: admin.name,
                email: admin.email,
                role: admin.role,
            },
        });
    } catch (error) {
        if (error.name === 'SequelizeUniqueConstraintError') {
            return res.status(400).json({ message: 'Admin already exists' });
        }
        console.error(error);
        res.status(500).json({ message: 'Server error' });
    }
};

exports.forgotPassword = async (req, res) => {
    try {
        const email = normalizeEmail(req.body?.email);
        if (!email) {
            return res.status(400).json({ success: false, message: 'Email is required' });
        }

        const genericMessage =
            'If an admin account exists for this email, a verification code has been sent';

        const admin = await Admin.findOne({ where: { email } });
        if (!admin) {
            return res.json({ success: true, message: genericMessage });
        }

        const otp = String(crypto.randomInt(100000, 1000000));
        await admin.update({
            resetPasswordToken: `${RESET_OTP_PREFIX}${hashSecret(otp)}`,
            resetPasswordExpires: new Date(Date.now() + RESET_OTP_TTL_MS),
            resetPasswordAttempts: 0,
        });

        const result = await sendAdminPasswordResetOtpEmail({
            admin,
            otp,
            expiryMinutes: Math.floor(RESET_OTP_TTL_MS / 60 / 1000),
        });
        if (!result.success) {
            console.error('Admin reset OTP email failed:', result.reason);
        }

        return res.json({ success: true, message: genericMessage });
    } catch (error) {
        console.error('Admin forgot password error:', error);
        return res.status(500).json({ success: false, message: 'Server error' });
    }
};

exports.verifyResetOtp = async (req, res) => {
    try {
        const email = normalizeEmail(req.body?.email);
        const otp = String(req.body?.otp || '').trim();

        if (!email) {
            return res.status(400).json({ success: false, message: 'Email is required' });
        }
        if (!/^\d{6}$/.test(otp)) {
            return res.status(400).json({ success: false, message: 'OTP must be a 6 digit code' });
        }

        const invalid = () =>
            res.status(400).json({ success: false, message: 'Invalid or expired OTP' });

        const admin = await Admin.findOne({
            where: {
                email,
                resetPasswordToken: { [Op.like]: `${RESET_OTP_PREFIX}%` },
                resetPasswordExpires: { [Op.gt]: new Date() },
            },
        });
        if (!admin) return invalid();

        const expected = Buffer.from(`${RESET_OTP_PREFIX}${hashSecret(otp)}`);
        const actual = Buffer.from(admin.resetPasswordToken);
        const matches =
            expected.length === actual.length && crypto.timingSafeEqual(expected, actual);

        if (!matches) {
            const attempts = (admin.resetPasswordAttempts || 0) + 1;
            await admin.update(
                attempts >= MAX_OTP_ATTEMPTS
                    ? clearResetState
                    : { resetPasswordAttempts: attempts }
            );
            return invalid();
        }

        const resetToken = crypto.randomBytes(32).toString('hex');
        await admin.update({
            resetPasswordToken: `${RESET_TOKEN_PREFIX}${hashSecret(resetToken)}`,
            resetPasswordExpires: new Date(Date.now() + RESET_TOKEN_TTL_MS),
            resetPasswordAttempts: 0,
        });

        return res.json({
            success: true,
            message: 'OTP verified',
            data: {
                resetToken,
                expiresInMinutes: Math.floor(RESET_TOKEN_TTL_MS / 60 / 1000),
            },
        });
    } catch (error) {
        console.error('Admin verify reset OTP error:', error);
        return res.status(500).json({ success: false, message: 'Server error' });
    }
};

exports.resetPassword = async (req, res) => {
    try {
        const { token } = req.params;
        const { newPassword } = req.body || {};

        if (typeof newPassword !== 'string' || newPassword.length < MIN_PASSWORD_LENGTH) {
            return res.status(400).json({
                success: false,
                message: `New password must be at least ${MIN_PASSWORD_LENGTH} characters`,
            });
        }

        const admin = await Admin.findOne({
            where: {
                resetPasswordToken: `${RESET_TOKEN_PREFIX}${hashSecret(token)}`,
                resetPasswordExpires: { [Op.gt]: new Date() },
            },
        });
        if (!admin) {
            return res.status(400).json({ success: false, message: 'Invalid or expired token' });
        }

        await admin.update({
            password: await bcrypt.hash(newPassword, 10),
            ...clearResetState,
        });

        return res.json({ success: true, message: 'Password reset successful' });
    } catch (error) {
        console.error('Admin reset password error:', error);
        return res.status(500).json({ success: false, message: 'Server error' });
    }
};

exports.changePassword = async (req, res) => {
    try {
        const { oldPassword, newPassword, confirmNewPassword } = req.body || {};

        if (!oldPassword || !newPassword || !confirmNewPassword) {
            return res.status(400).json({ success: false, message: 'All fields required' });
        }
        if (typeof newPassword !== 'string' || newPassword.length < MIN_PASSWORD_LENGTH) {
            return res.status(400).json({
                success: false,
                message: `New password must be at least ${MIN_PASSWORD_LENGTH} characters`,
            });
        }
        if (newPassword !== confirmNewPassword) {
            return res.status(400).json({ success: false, message: 'New password mismatch' });
        }

        const admin = await Admin.findByPk(req.user.id);
        if (!admin) {
            return res.status(404).json({ success: false, message: 'Admin not found' });
        }

        const isMatch = await bcrypt.compare(String(oldPassword), admin.password);
        if (!isMatch) {
            return res.status(400).json({ success: false, message: 'Old password incorrect' });
        }
        if (oldPassword === newPassword) {
            return res.status(400).json({
                success: false,
                message: 'New password must be different from the old password',
            });
        }

        await admin.update({
            password: await bcrypt.hash(newPassword, 10),
            ...clearResetState,
        });

        return res.json({ success: true, message: 'Password changed successfully' });
    } catch (error) {
        console.error('Admin change password error:', error);
        return res.status(500).json({ success: false, message: 'Server error' });
    }
};

