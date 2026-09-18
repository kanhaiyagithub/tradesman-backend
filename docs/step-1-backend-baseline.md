# Step 1 - Backend Baseline

This document captures the current backend surface before deeper refactors. It is based on the Express route wiring and the audit review.

## Runtime Shape

- App entry: `index.js`
- Express app: `app.js`
- Socket.IO entry: `socket.js`
- Database: MySQL through Sequelize
- Migrations: `migrations/` with `umzug`
- File storage: local provider through `services/storage/storageService.js`
- Jobs currently started in the API process:
  - travel-plan status refresh
  - notification cleanup
  - match reminder emails

## Mounted Route Groups

| Prefix | Route File | Purpose |
| --- | --- | --- |
| `/api/admin` | `routes/AdminRoute/adminRoutes.js` | Admin auth |
| `/api/admin` | `routes/AdminRoute/adminApprovalRoutes.js` | Tradesman approval |
| `/api/admin/dashboard` | `routes/AdminRoute/adminDashboardRoutes.js` | Admin dashboard stats |
| `/api/admin` | `routes/AdminRoute/adminReportsRoutes.js` | Admin reports |
| `/api/users` | `routes/userRoutes.js` | User auth, profiles, directory lists |
| `/api/auth` | `routes/googleRoutes.js` | Google OAuth and mobile Google login |
| `/api/hire` | `routes/hireRoutes.js` | Hire workflow, bookings, reviews |
| `/api/locations` | `routes/locationRoutes.js` | Travel plans |
| `/api/location` | `routes/liveLocationRoutes.js` | Live location update endpoint |
| `/api/subscriptions` | `routes/subscriptionRoutes.js` | Stripe plans and subscriptions |
| `/api/chat` | `routes/chatRoutes.js` | Direct chat and unread state |
| `/api/user` | `routes/portfolioRoutes.js` | Portfolio photos |
| `/api/trades` | `routes/tradesTypeRoutes.js` | Trade type lookup/search |
| `/api/notifications` | `routes/notificationRoutes.js` | Device tokens and inbox |
| `/api/client-trade-alerts` | `routes/clientTradeAlertRoutes.js` | Client trade alerts |
| `/api/matches` | `routes/matchRoutes.js` | Alert/route matches |

## Important Public Endpoints

- `GET /` - health check
- `POST /api/users/register` - user registration
- `POST /api/users/login` - password login
- `POST /api/users/forgot-password` - password reset request
- `POST /api/users/reset-password/:token` - password reset completion
- `GET /api/auth/google` - web Google OAuth start
- `GET /api/auth/google/callback` - web Google OAuth callback
- `POST /api/auth/google/mobile` - mobile Google login
- `GET /api/users/tradesmen` - tradesman directory
- `GET /api/users/tradesmen/filter` - tradesman filter
- `POST /api/users/tradesmen/filter` - tradesman filter
- `GET /api/users/clients` - client directory
- `GET /api/users/profile/:id` - public profile
- `GET /api/subscriptions/plans` - subscription plans
- `POST /api/subscriptions/webhook` - Stripe webhook, mounted before JSON parsing
- `GET /api/trades` - trade types
- `GET /api/trades/search` - trade search

## Important Authenticated Endpoints

- User profile: `GET /api/users/me`, `PUT /api/users/profile`, `PUT /api/users/profile/update`
- Password change: `PUT /api/users/change-password`
- User deletion: `DELETE /api/users/:id`
- Hire workflow: `/api/hire/request`, `/respond`, `/request-complete`, `/confirm-complete`, `/my`
- Travel plans: `/api/locations`
- Client alerts: `/api/client-trade-alerts`
- Matches: `/api/matches/my-alerts`, `/api/matches/my-route`
- Notifications: `/api/notifications`
- Chat: `/api/chat`
- Subscriptions: `/api/subscriptions/my` and mobile/web subscription mutation routes

## Socket Contract

Socket auth uses JWT during connection. The active events to preserve for the Flutter app are:

- `live-location:update`
- `send-message`
- `receive-message`
- `message-received`
- `register`
- `join-room`

## Keep Stable During Repairs

The audit recommends keeping the core product domain and avoiding a full rewrite. These areas should be preserved while hardening the platform:

- matching rules
- travel-plan status model
- chat schema and shared send path
- notification inbox behavior
- Stripe subscription mapping and raw webhook handling
- migration history
- Flutter-facing HTTP paths and socket events where possible

