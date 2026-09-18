const express = require('express');
const router = express.Router();
const adminAuth = require('../../controllers/AdminController/adminAuthController');
const Admin = require('../../models/AdminModel/adminModel');
const { verifyAdminToken } = require('../../middlewares/adminAuthMiddleware');
const { authRateLimiter } = require('../../middlewares/rateLimitMiddleware');

const allowFirstAdminOrRequireAdmin = async (req, res, next) => {
  try {
    const adminCount = await Admin.count();

    if (adminCount === 0) {
      return next();
    }

    return verifyAdminToken(req, res, next);
  } catch (error) {
    console.error('Admin registration guard error:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

router.post('/register', authRateLimiter, allowFirstAdminOrRequireAdmin, adminAuth.registerAdmin);
router.post('/login', authRateLimiter, adminAuth.login);   // <-- only this is correct

module.exports = router;
