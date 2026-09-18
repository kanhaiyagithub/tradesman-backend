const buckets = new Map();

const getClientKey = (req, scope) => {
  const forwardedFor = req.headers["x-forwarded-for"];
  const ip = Array.isArray(forwardedFor)
    ? forwardedFor[0]
    : String(forwardedFor || req.ip || req.socket?.remoteAddress || "unknown")
        .split(",")[0]
        .trim();

  return `${scope}:${ip}`;
};

const createRateLimiter = ({ windowMs, max, scope }) => (req, res, next) => {
  const now = Date.now();
  const key = getClientKey(req, scope);
  const current = buckets.get(key);

  if (!current || current.resetAt <= now) {
    buckets.set(key, {
      count: 1,
      resetAt: now + windowMs,
    });
    return next();
  }

  current.count += 1;

  if (current.count > max) {
    const retryAfterSeconds = Math.ceil((current.resetAt - now) / 1000);
    res.set("Retry-After", String(retryAfterSeconds));
    return res.status(429).json({
      success: false,
      message: "Too many requests. Please try again later.",
    });
  }

  return next();
};

const authRateLimiter = createRateLimiter({
  scope: "auth",
  windowMs: 15 * 60 * 1000,
  max: 20,
});

const passwordResetRateLimiter = createRateLimiter({
  scope: "password-reset",
  windowMs: 15 * 60 * 1000,
  max: 5,
});

module.exports = {
  authRateLimiter,
  passwordResetRateLimiter,
};
