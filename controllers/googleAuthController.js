const jwt = require('jsonwebtoken');
const User = require("../models/User");
const https = require("https");
const metaConversionService = require("../services/metaConversionService");
const { signRefreshToken } = require("../utils/authTokens");

const fetchJson = (url) =>
  new Promise((resolve, reject) => {
    if (typeof fetch === "function") {
      fetch(url)
        .then(async (response) => {
          const body = await response.json();
          if (!response.ok) {
            const error = new Error(
              body.error_description || "Google token verification failed"
            );
            error.statusCode = response.status;
            throw error;
          }
          return body;
        })
        .then(resolve)
        .catch(reject);
      return;
    }

    https
      .get(url, (response) => {
        let body = "";

        response.on("data", (chunk) => {
          body += chunk;
        });

        response.on("end", () => {
          try {
            const json = JSON.parse(body);
            if (response.statusCode < 200 || response.statusCode >= 300) {
              return reject(
                new Error(
                  json.error_description || "Google token verification failed"
                )
              );
            }
            return resolve(json);
          } catch (error) {
            return reject(error);
          }
        });
      })
      .on("error", reject);
  });

const getAllowedGoogleClientIds = () =>
  [
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_MOBILE_CLIENT_ID,
    ...(process.env.GOOGLE_CLIENT_IDS || "").split(","),
  ]
    .map((clientId) => String(clientId || "").trim())
    .filter(Boolean);

const verifyGoogleIdToken = async (idToken) => {
  const tokenInfo = await fetchJson(
    `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`
  );

  const allowedClientIds = getAllowedGoogleClientIds();

  if (allowedClientIds.length && !allowedClientIds.includes(tokenInfo.aud)) {
    throw new Error("Google token audience mismatch");
  }

  if (tokenInfo.email_verified !== "true" && tokenInfo.email_verified !== true) {
    throw new Error("Google email is not verified");
  }

  if (!tokenInfo.email) {
    throw new Error("Google token did not include an email");
  }

  return tokenInfo;
};

// Web OAuth callback
exports.googleCallback = async (req, res) => {
  try {
    const user = req.user;

    if (!user) {
      return res.status(400).json({
        success: false,
        message: "No user data found from Google"
      });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    return res.status(200).json({
      success: true,
      message: "Google signup/login successful",
      data: {
        token,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role
        }
      }
    });

  } catch (error) {
    console.error("Google Callback Error:", error);

    return res.status(500).json({
      success: false,
      message: "Google login failed"
    });
  }
};


// Flutter mobile login
exports.googleMobileLogin = async (req, res) => {
  try {
    const idToken = req.body.idToken || req.body.token;

    if (!idToken) {
      return res.status(400).json({
        success: false,
        message: "Google ID token missing"
      });
    }

    const googleProfile = await verifyGoogleIdToken(idToken);
    const email = String(googleProfile.email).toLowerCase();
    const name = googleProfile.name || email.split("@")[0];

    let user = await User.findOne({ where: { email } });

    if (!user) {
      user = await User.create({
        name,
        email,
        googleId: googleProfile.sub,
        profileImage: googleProfile.picture || null,
        provider: "google",
        isVerified: true
      });

      // Meta Conversions API: never throws and never blocks login.
      await metaConversionService.trackRegistration({
        user,
        method: "google",
        metaAttribution: req.body.metaAttribution,
        ip: req.ip,
        userAgent: req.get("User-Agent"),
      });
    } else {
      const changedFields = {};

      if (!user.googleId && googleProfile.sub) changedFields.googleId = googleProfile.sub;
      if (user.provider !== "google") changedFields.provider = "google";
      if (!user.isVerified) changedFields.isVerified = true;
      if (!user.profileImage && googleProfile.picture) {
        changedFields.profileImage = googleProfile.picture;
      }

      if (Object.keys(changedFields).length) {
        await user.update(changedFields);
      }

      // Existing user: just refresh device / attribution info.
      await metaConversionService.trackAttributionOnly({
        userId: user.id,
        metaAttribution: req.body.metaAttribution,
        ip: req.ip,
        userAgent: req.get("User-Agent"),
      });
    }

    const jwtToken = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    return res.status(200).json({
      success: true,
      message: "Google mobile login successful",
      data: {
        token: jwtToken,
        refreshToken: signRefreshToken(user),
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role
        }
      }
    });

  } catch (error) {
    console.error("Google Mobile Login Error:", error);

    return res.status(401).json({
      success: false,
      message: "Google mobile login failed"
    });
  }
};
