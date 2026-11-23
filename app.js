const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
const session = require('express-session');
const helmet = require('helmet');
const passport = require('passport');
const storageConfig = require('./config/storage');
const { isOriginAllowed } = require('./utils/securityConfig');
const { blockPrivateUploads } = require('./middlewares/privateUploads');
const { generalRateLimiter } = require('./middlewares/rateLimitMiddleware');
const { handleUploadErrors } = require('./middlewares/uploadMiddleware');

// dotenv.config({ path: './config/config.env' });
dotenv.config();

// A default signing secret is unsafe in production: fail fast when it is missing.
if (!process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET is required. Set it in the environment before starting the server.');
}

// Production needs its own admin/refresh signing secrets so token kinds cannot be mixed up.
require('./utils/authTokens').assertProductionSecrets();

if (process.env.NODE_ENV === 'production') {
  const hasGoogleClientId = [
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_MOBILE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_IDS,
  ].some((value) => String(value || '').trim());

  if (!hasGoogleClientId) {
    throw new Error('A Google client ID (GOOGLE_CLIENT_ID / GOOGLE_MOBILE_CLIENT_ID) is required in production.');
  }
}

require('./config/passport');

const stripeWebhookController = require('./controllers/stripeWebhookController');

const adminRoutes = require('./routes/AdminRoute/adminRoutes');
const userRoutes = require('./routes/userRoutes');
const googleRoutes = require('./routes/googleRoutes');
const hireRoutes = require('./routes/hireRoutes');
const locationRoutes = require('./routes/locationRoutes');
const subscriptionRoutes = require('./routes/subscriptionRoutes');
const chatRoutes = require('./routes/chatRoutes');
const adminApprovalRoutes = require('./routes/AdminRoute/adminApprovalRoutes');
const adminDashboardRoutes = require('./routes/AdminRoute/adminDashboardRoutes');
const adminTradesTypeRoutes = require('./routes/AdminRoute/adminTradesTypeRoutes');
const adminManagementRoutes = require('./routes/AdminRoute/adminManagementRoutes');
const adminDummyUsersRoutes = require('./routes/AdminRoute/adminDummyUsersRoutes');
const adminReportsRoutes = require('./routes/AdminRoute/adminReportsRoutes');
const portfolioRoutes = require('./routes/portfolioRoutes');
const tradesTypeRoutes = require('./routes/tradesTypeRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const clientTradeAlertRoutes = require('./routes/clientTradeAlertRoutes');
const liveLocationRoutes = require('./routes/liveLocationRoutes');
const matchRoutes = require('./routes/matchRoutes');
const metaRoutes = require('./routes/metaRoutes');

const app = express();

// Do not advertise the framework, and set the standard security headers (nosniff, HSTS, ...).
// Uploaded photos are loaded by other origins (admin panel), so allow cross-origin reads.
app.disable('x-powered-by');
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));

if (process.env.TRUST_PROXY === 'true') {
  // Trust first proxy when behind a reverse proxy (nginx, ALB, etc.).
  app.set('trust proxy', 1);
}

app.use(
  cors({
    origin(origin, callback) {
      if (isOriginAllowed(origin)) {
        return callback(null, true);
      }

      return callback(new Error('CORS origin is not allowed'));
    },
    credentials: true,
  })
);

/* ===========================
   STRIPE WEBHOOK FIRST
   =========================== */
app.post(
  '/api/subscriptions/webhook',
  express.raw({ type: 'application/json' }),
  stripeWebhookController.handleWebhook
);

// General per-IP limit for everything except the Stripe webhook above.
app.use('/api', generalRateLimiter);

/* ===========================
   JSON PARSER AFTER WEBHOOK
   =========================== */
app.use(express.json());

/**
 * Legacy local uploads remain served during the storage-migration phase.
 *
 * Phase 1A does not change file storage behavior. It only removes runtime
 * schema mutation from app startup.
 */
// Licence documents are personal data: never served by URL. Admins read them through
// GET /api/admin/tradesmen/:userId/license (authenticated). Photos below stay public.
app.use(
  storageConfig.local.publicBasePath,
  blockPrivateUploads,
  express.static(storageConfig.local.rootDir)
);

app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
    },
  })
);

app.use(passport.initialize());
app.use(passport.session());

/* ===========================
   ROUTES
   =========================== */
app.use('/api/admin', adminRoutes);
app.use('/api/users', userRoutes);
app.use('/api/auth', googleRoutes);
app.use('/api/hire', hireRoutes);
app.use('/api/locations', locationRoutes);
app.use('/api/subscriptions', subscriptionRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/admin', adminApprovalRoutes);
app.use('/api/admin/dashboard', adminDashboardRoutes);
app.use('/api/admin/trades', adminTradesTypeRoutes);
app.use('/api/admin/admins', adminManagementRoutes);
app.use('/api/admin/dummy-users', adminDummyUsersRoutes);
app.use('/api/admin', adminReportsRoutes);
app.use('/api/user', portfolioRoutes);
app.use('/api/trades', tradesTypeRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/client-trade-alerts', clientTradeAlertRoutes);
app.use('/api/location', liveLocationRoutes);
app.use('/api/matches', matchRoutes);
app.use('/api/meta', metaRoutes);

/**
 * Simple app health route.
 *
 * Keep this endpoint lightweight so load balancers and uptime checks can use it
 * without touching the database or any heavy domain services.
 */
app.get('/', (req, res) => {
  res.send('✅ Tradesman Travel App API is running...');
});

/* ===========================
   ERROR HANDLING
   =========================== */
app.use(handleUploadErrors);

// Last resort: never leak internals (stack traces, error.message) to the client.
// eslint-disable-next-line no-unused-vars
app.use((error, req, res, next) => {
  if (error?.message === 'CORS origin is not allowed') {
    return res.status(403).json({ success: false, message: 'Origin not allowed' });
  }

  if (error?.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, message: 'Invalid JSON body' });
  }

  console.error('[UNHANDLED ERROR]', req.method, req.originalUrl, error);
  if (res.headersSent) return next(error);
  return res.status(error?.status || 500).json({
    success: false,
    message: error?.status && error.status < 500 ? error.message : 'Server error',
  });
});

module.exports = app;
