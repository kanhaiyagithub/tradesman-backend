const express = require('express');
const passport = require('passport');
const { googleCallback, googleMobileLogin } = require('../controllers/googleAuthController');
const { authRateLimiter } = require('../middlewares/rateLimitMiddleware');

const router = express.Router();

// Web login
router.get(
  '/google',
  passport.authenticate('google', { scope: ['profile', 'email'] })
);

router.get(
  '/google/callback',
  passport.authenticate('google', { failureRedirect: '/login', session: false }),
  googleCallback
);

// Flutter mobile login
router.post('/google/mobile', authRateLimiter, googleMobileLogin);

module.exports = router;
