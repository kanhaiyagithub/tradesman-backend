const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
const session = require('express-session');
const passport = require('passport');
const sequelize = require('./config/db');
const path = require("path");

dotenv.config({ path: './config/config.env' });

require('./config/passport');

const stripeWebhookController = require('./controllers/stripeWebhookController');

const adminRoutes = require('./routes/AdminRoute/adminRoutes');
const userRoutes = require('./routes/userRoutes');
const googleRoutes = require('./routes/googleRoutes');
const hireRoutes = require('./routes/hireRoutes');
const locationRoutes = require("./routes/locationRoutes");
const subscriptionRoutes = require("./routes/subscriptionRoutes");
const chatRoutes = require('./routes/chatRoutes');
const adminApprovalRoutes = require('./routes/AdminRoute/adminApprovalRoutes');
const adminDashboardRoutes = require('./routes/AdminRoute/adminDashboardRoutes');
const adminReportsRoutes = require('./routes/AdminRoute/adminReportsRoutes');
const portfolioRoutes = require('./routes/portfolioRoutes');
const tradesTypeRoutes = require("./routes/tradesTypeRoutes");

const app = express();

app.use(cors());

/* ===========================
   🔥 STRIPE WEBHOOK FIRST
   =========================== */

app.post(
  "/api/subscriptions/webhook",
  express.raw({ type: "application/json" }),
  stripeWebhookController.handleWebhook
);

/* ===========================
   JSON PARSER AFTER WEBHOOK
   =========================== */

app.use(express.json());

app.use("/uploads", express.static(path.join(__dirname, "uploads")));

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
app.use("/api/subscriptions", subscriptionRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/admin', adminApprovalRoutes);
app.use("/api/admin/dashboard", adminDashboardRoutes);
app.use("/api/admin", adminReportsRoutes);
app.use("/api/user", portfolioRoutes);
app.use("/api/trades", tradesTypeRoutes);

app.get('/', (req, res) => {
  res.send('✅ Tradesman Travel App API is running...');
});

sequelize
  .sync({ alter: true })
  .then(() => console.log('✅ MySQL Database synced successfully'))
  .catch((err) => console.error('❌ Database sync error:', err));

module.exports = app;