const buckets = new Map();

const getClientKey = (req, scope) => {
  // req.ip already respects trust proxy when configured
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
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

const resetRateLimitBuckets = () => {
  buckets.clear();
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
  resetRateLimitBuckets,
};
