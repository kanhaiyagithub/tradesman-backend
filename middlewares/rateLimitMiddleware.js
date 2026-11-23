const buckets = new Map();

const getClientKey = (req, scope) => {
  // req.ip already respects trust proxy when configured
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  return `${scope}:${ip}`;
};

// Expired buckets are dropped so the map cannot grow forever.
// Buckets live in this process only: with several instances, use a shared store (Redis).
const PRUNE_INTERVAL_MS = 5 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}, PRUNE_INTERVAL_MS).unref();

/**
 * `keyBy(req)` may return an extra identifier (user id, email) to limit per
 * account instead of only per IP; a falsy value falls back to the IP.
 */
const createRateLimiter = ({ windowMs, max, scope, keyBy }) => (req, res, next) => {
  const now = Date.now();
  const identity = keyBy ? keyBy(req) : null;
  const key = identity ? `${scope}:${identity}` : getClientKey(req, scope);
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

const emailOf = (req) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  return email ? `email:${email}` : null;
};

// Separate buckets so one flow cannot exhaust another (short access tokens mean frequent refreshes).
const loginRateLimiter = createRateLimiter({ scope: "login", windowMs: 15 * 60 * 1000, max: 20 });
const loginAccountRateLimiter = createRateLimiter({
  scope: "login-account",
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyBy: emailOf,
});
const refreshRateLimiter = createRateLimiter({ scope: "refresh", windowMs: 15 * 60 * 1000, max: 120 });
const adminLoginRateLimiter = createRateLimiter({ scope: "admin-login", windowMs: 15 * 60 * 1000, max: 10 });
const adminLoginAccountRateLimiter = createRateLimiter({
  scope: "admin-login-account",
  windowMs: 15 * 60 * 1000,
  max: 5,
  keyBy: emailOf,
});
const passwordResetEmailRateLimiter = createRateLimiter({
  scope: "password-reset-account",
  windowMs: 60 * 60 * 1000,
  max: 10,
  keyBy: emailOf,
});
const chatMessageRateLimiter = createRateLimiter({
  scope: "chat-message",
  windowMs: 60 * 1000,
  max: 30,
  keyBy: (req) => (req.user?.id ? `user:${req.user.id}` : null),
});
const generalRateLimiter = createRateLimiter({ scope: "general", windowMs: 60 * 1000, max: 300 });

module.exports = {
  loginRateLimiter,
  loginAccountRateLimiter,
  refreshRateLimiter,
  adminLoginRateLimiter,
  adminLoginAccountRateLimiter,
  passwordResetEmailRateLimiter,
  chatMessageRateLimiter,
  generalRateLimiter,
  authRateLimiter,
  passwordResetRateLimiter,
  resetRateLimitBuckets,
};
