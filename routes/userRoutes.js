const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');
const { verifyToken } = require('../middlewares/authMiddleware');
const { upload, convertToJpg } = require('../middlewares/uploadMiddleware');

// Public Routes
router.post(
  '/register',
  upload.fields([
    { name: 'profileImage', maxCount: 1 },
    { name: 'licenseDocument', maxCount: 1 },
    { name: 'portfolioPhotos', maxCount: 10 },
  ]),
  convertToJpg,
  userController.register
);

router.post('/login', userController.login);

// Lists
router.get('/tradesmen', userController.getAllTradesmen);
router.get('/clients', userController.getAllClients);

// ✅ SINGLE FILTER ROUTE (FIXED)
router.get('/tradesmen/filter', userController.filterTradesmen);

// Profiles
router.get('/profile/:id', userController.getFullUserProfile);
router.get('/me', verifyToken, userController.getMeProfile);

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
    { name: "portfolioPhotos", maxCount: 10 },
  ]),
  userController.updateTradesmanProfile
);

// Users
router.get('/', userController.getAllUsers);
router.get('/:id', userController.getUserById);
router.delete('/:id', verifyToken, userController.deleteUser);

// Password reset
router.post('/forgot-password', userController.forgotPassword);
router.post('/reset-password/:token', userController.resetPassword);

module.exports = router;