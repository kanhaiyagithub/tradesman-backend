const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
const session = require('express-session');
const passport = require('passport');
const path = require('path');
const storageConfig = require('./config/storage');

// dotenv.config({ path: './config/config.env' });
dotenv.config();

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
const adminReportsRoutes = require('./routes/AdminRoute/adminReportsRoutes');
const portfolioRoutes = require('./routes/portfolioRoutes');
const tradesTypeRoutes = require('./routes/tradesTypeRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const clientTradeAlertRoutes = require('./routes/clientTradeAlertRoutes');
const liveLocationRoutes = require('./routes/liveLocationRoutes');
const matchRoutes = require('./routes/matchRoutes');

const app = express();

app.use(cors());

/* ===========================
   STRIPE WEBHOOK FIRST
   =========================== */
app.post(
  '/api/subscriptions/webhook',
  express.raw({ type: 'application/json' }),
  stripeWebhookController.handleWebhook
);

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
app.use(
  storageConfig.local.publicBasePath,
  express.static(storageConfig.local.rootDir)
);

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'your_secret_key',
    resave: false,
    saveUninitialized: false,
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
app.use('/api/admin', adminReportsRoutes);
app.use('/api/user', portfolioRoutes);
app.use('/api/trades', tradesTypeRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/client-trade-alerts', clientTradeAlertRoutes);
app.use('/api/location', liveLocationRoutes);
app.use('/api/matches', matchRoutes);

/**
 * Simple app health route.
 *
 * Keep this endpoint lightweight so load balancers and uptime checks can use it
 * without touching the database or any heavy domain services.
 */
app.get('/', (req, res) => {
  res.send('✅ Tradesman Travel App API is running...');
});

module.exports = app;
