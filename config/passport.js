// config/passport.js
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const User = require("../models/User");

passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,      // ✅ from .env
      clientSecret: process.env.GOOGLE_CLIENT_SECRET, // ✅ from .env
      callbackURL:
        process.env.GOOGLE_CALLBACK_URL ||
        'http://localhost:5000/api/auth/google/callback',
    },
    async (accessToken, refreshToken, profile, done) => {
      try {
        const emailEntry = profile.emails?.[0];
        const googleId = profile.id;

        if (!emailEntry?.value) {
          return done(new Error("Google profile missing email"), null);
        }

        const emailVerified =
          emailEntry.verified === true || profile._json?.email_verified === true;

        // Verify Google confirmed email ownership.
        if (!emailVerified) {
          return done(new Error("Google email is not verified"), null);
        }

        const email = String(emailEntry.value).toLowerCase();

        // Try to find by googleId first (existing Google user)
        let user = await User.findOne({ where: { googleId } });

        if (!user) {
          // Check if email exists - only link if already verified or Google-based
          const existingUser = await User.findOne({ where: { email } });

          if (existingUser) {
            // Only auto-link if account was verified or previously used Google
            if (existingUser.isVerified || existingUser.provider === "google") {
              user = existingUser;
              await user.update({
                googleId,
                provider: "google",
                isVerified: true,
                profileImage: user.profileImage || profile.photos?.[0]?.value,
              });
            } else {
              // Reject linking to unverified password-only accounts
              return done(
                new Error("Email exists but is not verified. Please verify your email first."),
                null
              );
            }
          } else {
            // New user - create via Google
            user = await User.create({
              googleId,
              name: profile.displayName,
              email,
              profileImage: profile.photos?.[0]?.value,
              provider: "google",
              isVerified: true,
            });
          }
        } else {
          // Update existing Google user's profile if needed
          const updates = {};
          if (!user.profileImage && profile.photos?.[0]?.value) {
            updates.profileImage = profile.photos[0].value;
          }
          if (!user.isVerified) {
            updates.isVerified = true;
          }
          if (Object.keys(updates).length) {
            await user.update(updates);
          }
        }

        return done(null, user);
      } catch (err) {
        return done(err, null);
      }
    }
  )
);

// Serialize / Deserialize user for session support (optional)
passport.serializeUser((user, done) => {
  done(null, user.id);
});
passport.deserializeUser(async (id, done) => {
  const user = await User.findByPk(id);
  done(null, user);
});

module.exports = passport;
