const jwt = require('jsonwebtoken');
require('dotenv').config({ path: './config/config.env' });

/**
 * Every authentication failure is a 401 with the same body shape
 * { success: false, message, code } so the app can tell an expired token
 * (refresh or re-login) from a wrong password (400 from /login).
 *
 * code: TOKEN_MISSING | TOKEN_EXPIRED | TOKEN_INVALID
 */
const unauthorized = (res, code, message) =>
  res.status(401).json({ success: false, message, code });

exports.verifyToken = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return unauthorized(res, 'TOKEN_MISSING', 'Unauthorized: No token provided');
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Refresh tokens are only accepted by the refresh endpoint.
    if (decoded.type === 'refresh') {
      return unauthorized(res, 'TOKEN_INVALID', 'Invalid token');
    }

    req.user = decoded;   // { id, email, role, iat, exp }
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return unauthorized(res, 'TOKEN_EXPIRED', 'Token expired');
    }

    console.error('verifyToken error:', error.message);
    return unauthorized(res, 'TOKEN_INVALID', 'Invalid token');
  }
};
