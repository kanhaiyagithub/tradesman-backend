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
const DEFAULT_ACCESS_EXPIRES_IN = "15m";
const DEFAULT_ADMIN_EXPIRES_IN = "1h";
const ALGORITHM = "HS256";

/**
 * Three token kinds, each with its own `type` claim and signing secret so one
 * can never be accepted as another:
 *   access  - JWT_SECRET,         15m, user API + sockets
 *   refresh - JWT_REFRESH_SECRET, 60d, POST /api/users/refresh-token only
 *   admin   - JWT_ADMIN_SECRET,   1h,  admin panel only
 * JWT_REFRESH_SECRET and JWT_ADMIN_SECRET are required in production
 * (assertProductionSecrets); elsewhere they are derived from JWT_SECRET.
 */
const deriveSecret = (envName, label) =>
  process.env[envName] || `${process.env.JWT_SECRET}:${label}`;

const getAccessSecret = () => process.env.JWT_SECRET;
const getRefreshSecret = () => deriveSecret("JWT_REFRESH_SECRET", "refresh");
const getAdminSecret = () => deriveSecret("JWT_ADMIN_SECRET", "admin");

const assertProductionSecrets = () => {
  if (process.env.NODE_ENV !== "production") return;
  const missing = ["JWT_SECRET", "JWT_REFRESH_SECRET", "JWT_ADMIN_SECRET"].filter(
    (name) => !process.env[name]
  );
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
};

const getRefreshExpiresIn = () =>
  process.env.JWT_REFRESH_EXPIRES_IN || DEFAULT_REFRESH_EXPIRES_IN;

/** Short, non-reversible fingerprint of the current password hash. */
const passwordFingerprint = (user) =>
  crypto
    .createHash("sha256")
    .update(String(user.password || ""))
    .digest("hex")
    .slice(0, 16);

const signAccessToken = (user) =>
  jwt.sign(
    { id: user.id, email: user.email, role: user.role, type: "access" },
    getAccessSecret(),
    {
      expiresIn: process.env.JWT_ACCESS_EXPIRES_IN || DEFAULT_ACCESS_EXPIRES_IN,
      algorithm: ALGORITHM,
    }
  );

const signRefreshToken = (user) =>
  jwt.sign(
    { id: user.id, type: "refresh", pv: passwordFingerprint(user) },
    getRefreshSecret(),
    { expiresIn: getRefreshExpiresIn(), algorithm: ALGORITHM }
  );

// The claim only says "this is an admin token". Super-admin status is read from the
// database on every request, so it can change without re-login.
const signAdminToken = (admin) =>
  jwt.sign({ id: admin.id, role: "admin", type: "admin" }, getAdminSecret(), {
    expiresIn: process.env.JWT_ADMIN_EXPIRES_IN || DEFAULT_ADMIN_EXPIRES_IN,
    algorithm: ALGORITHM,
  });

const invalidToken = (message) => {
  const error = new Error(message);
  error.name = "JsonWebTokenError";
  return error;
};

/** Verifies a user access token. Throws jsonwebtoken errors on any problem. */
const verifyAccessToken = (token) => {
  const decoded = jwt.verify(String(token || ""), getAccessSecret(), {
    algorithms: [ALGORITHM],
  });
  if (decoded.type !== "access") throw invalidToken("Not an access token");
  return decoded;
};

/** Verifies an admin token. Throws jsonwebtoken errors on any problem. */
const verifyAdminJwt = (token) => {
  const decoded = jwt.verify(String(token || ""), getAdminSecret(), {
    algorithms: [ALGORITHM],
  });
  if (decoded.type !== "admin") throw invalidToken("Not an admin token");
  return decoded;
};

/**
 * Verifies a refresh token and returns its payload.
 * Throws a jsonwebtoken error (TokenExpiredError / JsonWebTokenError).
 */
const verifyRefreshToken = (token) => {
  const decoded = jwt.verify(String(token || ""), getRefreshSecret(), {
    algorithms: [ALGORITHM],
  });
  if (decoded.type !== "refresh") throw invalidToken("Not a refresh token");
  return decoded;
};

module.exports = {
  assertProductionSecrets,
  passwordFingerprint,
  getAccessSecret,
  getRefreshSecret,
  getAdminSecret,
  signAccessToken,
  signAdminToken,
  signRefreshToken,
  verifyAccessToken,
  verifyAdminJwt,
  verifyRefreshToken,
};
