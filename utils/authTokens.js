const crypto = require("crypto");
const jwt = require("jsonwebtoken");

/**
 * Refresh tokens: a long-lived, stateless token that can only be exchanged for
 * a new access token at POST /api/users/refresh-token. It is a JWT signed with
 * the same secret but marked `type: "refresh"`, which verifyToken and the
 * socket auth reject, so it can never be used as an access token.
 *
 * It carries a fingerprint of the user's current password hash (`pv`), so
 * changing or resetting the password invalidates every refresh token.
 * Tokens are not stored server-side, so a single token cannot be revoked
 * individually before it expires.
 */

const DEFAULT_REFRESH_EXPIRES_IN = "60d";

const getRefreshExpiresIn = () =>
  process.env.JWT_REFRESH_EXPIRES_IN || DEFAULT_REFRESH_EXPIRES_IN;

/** Short, non-reversible fingerprint of the current password hash. */
const passwordFingerprint = (user) =>
  crypto
    .createHash("sha256")
    .update(String(user.password || ""))
    .digest("hex")
    .slice(0, 16);

const signRefreshToken = (user) =>
  jwt.sign(
    { id: user.id, type: "refresh", pv: passwordFingerprint(user) },
    process.env.JWT_SECRET,
    { expiresIn: getRefreshExpiresIn() }
  );

/**
 * Verifies a refresh token and returns its payload.
 * Throws a jsonwebtoken error (TokenExpiredError / JsonWebTokenError) or an
 * Error with code TOKEN_INVALID when it is not a refresh token.
 */
const verifyRefreshToken = (token) => {
  const decoded = jwt.verify(String(token || ""), process.env.JWT_SECRET);

  if (decoded.type !== "refresh") {
    const error = new Error("Not a refresh token");
    error.name = "JsonWebTokenError";
    throw error;
  }

  return decoded;
};

module.exports = {
  passwordFingerprint,
  signRefreshToken,
  verifyRefreshToken,
};
