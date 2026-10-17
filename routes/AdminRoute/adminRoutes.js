const express = require('express');
const router = express.Router();
const adminAuth = require('../../controllers/AdminController/adminAuthController');
const Admin = require('../../models/AdminModel/adminModel');
const { verifyAdminToken, requireSuperAdmin } = require('../../middlewares/adminAuthMiddleware');
const { authRateLimiter, passwordResetRateLimiter } = require('../../middlewares/rateLimitMiddleware');

const allowFirstAdminOrRequireAdmin = async (req, res, next) => {
  try {
    const adminCount = await Admin.count();

    if (adminCount === 0) {
      return next();
    }

    // Once an admin exists, only the super admin can create more admins.
    return verifyAdminToken(req, res, (error) => {
      if (error) return next(error);
      return requireSuperAdmin(req, res, next);
    });
  } catch (error) {
    console.error('Admin registration guard error:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

router.post('/register', authRateLimiter, allowFirstAdminOrRequireAdmin, adminAuth.registerAdmin);
router.post('/login', authRateLimiter, adminAuth.login);   // <-- only this is correct
router.post('/forgot-password', passwordResetRateLimiter, adminAuth.forgotPassword);
router.post('/verify-otp', passwordResetRateLimiter, adminAuth.verifyResetOtp);
router.post('/reset-password/:token', passwordResetRateLimiter, adminAuth.resetPassword);
router.post('/change-password', authRateLimiter, verifyAdminToken, adminAuth.changePassword);

module.exports = router;
