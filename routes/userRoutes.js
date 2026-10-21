const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');
const { verifyToken } = require('../middlewares/authMiddleware');
const { upload, convertToJpg } = require('../middlewares/uploadMiddleware');
const {
  requireAccountPassword,
  getAccountVerificationMethod,
  sendAccountOtp,
} = require('../middlewares/accountPasswordMiddleware');
const {
  authRateLimiter,
  passwordResetRateLimiter,
} = require('../middlewares/rateLimitMiddleware');

// Public Routes
router.post(
  '/register',
  authRateLimiter,
  upload.fields([
    { name: 'profileImage', maxCount: 1 },
    { name: 'licenseDocument', maxCount: 1 },
    { name: 'portfolioPhotos', maxCount: 10 },
  ]),
  convertToJpg,
  userController.register
);

router.post('/login', authRateLimiter, userController.login);
router.post('/refresh-token', authRateLimiter, userController.refreshToken);

// Lists
router.get('/tradesmen', userController.getAllTradesmen);
router.get('/clients', verifyToken, userController.getAllClients);

// ✅ FILTER ROUTE (supports GET + POST)
// Requires a login: the response includes where tradesmen currently are.
router.get('/tradesmen/filter', verifyToken, userController.filterTradesmen);
router.post('/tradesmen/filter', verifyToken, userController.filterTradesmen);

// Profiles
router.get('/account-verification', verifyToken, getAccountVerificationMethod);
router.post('/account-otp', verifyToken, authRateLimiter, sendAccountOtp);

router.get('/profile/:id', userController.getFullUserProfile);
router.get('/me', verifyToken, userController.getMeProfile);
router.get('/clients/:clientId/profile', verifyToken, userController.getClientProfileForTradesman);

// Update
router.put('/change-password', verifyToken, userController.changePassword);

router.put(
  "/profile",
  verifyToken,
  upload.single("profileImage"),
  convertToJpg,
  userController.updateProfile
);

router.put(
  "/profile/update",
  verifyToken,
  upload.fields([
    { name: "profileImage", maxCount: 1 },
    { name: "licenseDocument", maxCount: 1 },
    { name: "portfolioPhotos", maxCount: 10 },
  ]),
  userController.updateTradesmanProfile
);

router.post(
  "/profile/resubmit",
  verifyToken,
  upload.fields([
    { name: "profileImage", maxCount: 1 },
    { name: "licenseDocument", maxCount: 1 },
    { name: "portfolioPhotos", maxCount: 10 },
  ]),
  convertToJpg,
  userController.resubmitTradesmanVerification
);

// Users
router.get('/', verifyToken, userController.getAllUsers);
router.get('/:id', userController.getUserById);
router.delete(
  '/:id',
  verifyToken,
  authRateLimiter,
  requireAccountPassword('DELETE', { onlyOwnAccountParam: 'id' }),
  userController.deleteUser
);

// Password reset
router.post('/forgot-password', passwordResetRateLimiter, userController.forgotPassword);
router.post('/verify-reset-otp', passwordResetRateLimiter, userController.verifyResetOtp);
router.post('/reset-password/:token', passwordResetRateLimiter, userController.resetPassword);



module.exports = router;
