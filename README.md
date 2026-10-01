# Tradesman Backend API

Backend API for a tradesman travel and hiring platform. The service supports user and admin authentication, tradesman profiles, portfolio uploads, travel plans, client trade alerts, live location matching, chat, hire workflows, reviews, subscriptions, notifications, and admin reporting.

## Tech Stack

- Node.js
- Express
- MySQL
- Sequelize
- Umzug migrations
- Socket.IO
- Passport Google OAuth
- Stripe subscriptions
- Firebase Admin for push notifications
- Nodemailer SMTP email
- Multer and Sharp for uploads and image conversion

## Project Structure

```text
.
+-- app.js                         # Express app, middleware, route mounting
+-- index.js                       # Main HTTP + Socket.IO entry point
+-- socket.js                      # Authenticated Socket.IO events
+-- config/                        # Database, email, OAuth, storage, plan config
+-- controllers/                   # HTTP request handlers
+-- database/migrator.js           # Umzug migration setup
+-- middlewares/                   # Auth and upload middleware
+-- migrations/                    # Database schema migrations
+-- models/                        # Sequelize models
+-- routes/                        # API route definitions
+-- scripts/                       # Maintenance, migration, seed, email scripts
+-- services/                      # Domain services and background jobs
+-- utils/                         # Shared helpers
```

## Prerequisites

- Node.js 18 or newer
- npm
- MySQL 8 or compatible MySQL server
- Stripe account and API keys for subscription flows
- Google OAuth app credentials for Google login
- SMTP mailbox or email provider credentials
- Firebase service account credentials if push notifications are enabled

## Installation

1. Install dependencies:

```bash
npm install
```

2. Create a MySQL database:

```sql
CREATE DATABASE tradesman_backend CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

3. Create a `.env` file in the project root.

4. Run database migrations:

```bash
npm run db:migrate
```

5. Start the API:

```bash
npm run dev
```

For production-style startup:

```bash
npm start
```

The default server port is `5000`.

## Environment Variables

Create `.env` in the project root. The app uses `dotenv.config()` without a custom path, so root `.env` is the expected location.

```env
# Server
PORT=5000
APP_BASE_URL=http://localhost:5000
FRONTEND_URL=http://localhost:3000
SESSION_SECRET=replace-with-session-secret

# Database
DB_HOST=127.0.0.1
DB_PORT=3306
DB_NAME=tradesman_backend
DB_USER=root
DB_PASS=
DB_POOL_MAX=10
DB_POOL_MIN=0
DB_POOL_ACQUIRE_MS=30000
DB_POOL_IDLE_MS=10000

# JWT
JWT_SECRET=replace-with-long-random-secret
JWT_EXPIRE=7d

# Google OAuth
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret
GOOGLE_MOBILE_CLIENT_ID=your-mobile-google-client-id
GOOGLE_CLIENT_IDS=optional-extra-client-id-1,optional-extra-client-id-2

# Stripe
STRIPE_SECRET_KEY=sk_test_xxx
STRIPE_PUBLISHABLE_KEY=pk_test_xxx
STRIPE_WEBHOOK_SECRET=whsec_xxx
STRIPE_EPHEMERAL_KEY_API_VERSION=2024-06-20

# SMTP email
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-email@example.com
SMTP_PASS=your-app-password
SMTP_FROM="Tradesman App <your-email@example.com>"
EMAIL_TIMEZONE=Australia/Sydney
EMAIL_TEST_TO=test-recipient@example.com

# Background jobs
TRAVEL_PLAN_STATUS_REFRESH_INTERVAL_MS=60000
NOTIFICATION_RETENTION_DAYS=10
NOTIFICATION_CLEANUP_INTERVAL_MS=86400000
EMAIL_REMINDER_RUN_HOUR=8
EMAIL_REMINDER_RUN_MINUTE=0
EMAIL_REMINDER_RUN_ON_START=false

# Storage
STORAGE_DRIVER=local
LOCAL_UPLOAD_ROOT=uploads
LOCAL_UPLOAD_PUBLIC_BASE=/uploads
```

### Notes

- `JWT_SECRET`, `DB_*`, and the Stripe/SMTP keys are required for the related features to work.
- Gmail SMTP usually requires 2-step verification and an app password.
- Google OAuth callback is currently configured as `http://localhost:5000/api/auth/google/callback` in `config/passport.js`.
- Local uploads are served from `LOCAL_UPLOAD_PUBLIC_BASE`, defaulting to `/uploads`.

## Database

This project uses explicit migrations through Umzug. Runtime schema mutation with `sequelize.sync()` is not used.

Common commands:

```bash
npm run db:check
npm run db:migrate
npm run db:migrate:status
npm run db:migrate:down
```

Migration files live in `migrations/` and are tracked in the `SequelizeMeta` table.

## Available Scripts

| Command | Description |
| --- | --- |
| `npm start` | Starts the API with `node index.js`. |
| `npm run dev` | Starts the API with `nodemon index.js`. |
| `npm run db:check` | Checks database connectivity. |
| `npm run db:migrate` | Applies pending migrations. |
| `npm run db:migrate:down` | Rolls back the latest migration. |
| `npm run db:migrate:status` | Shows migration status. |
| `npm run chat:backfill` | Backfills chat conversation records. |
| `npm run chat:backfill:dry` | Dry-runs chat conversation backfill. |
| `npm run chat:migrate:conversation-id` | Migrates message conversation IDs. |
| `npm run chat:migrate:conversation-id:dry` | Dry-runs message conversation ID migration. |
| `npm run subscriptions:seed` | Creates/seeds Stripe subscription plans. |
| `npm run email:reminders` | Runs match reminder emails. |
| `npm run email:test` | Sends a test email. |

## Authentication

Protected user routes require a JWT bearer token:

```http
Authorization: Bearer <token>
```

Protected admin routes require an admin JWT bearer token generated by the admin login endpoint.

Socket.IO connections also require a JWT, either in the `Authorization` header or in the Socket.IO auth payload:

```js
io("http://localhost:5000", {
  auth: { token: "<jwt>" }
});
```

## API Routes

Base URL in local development:

```text
http://localhost:5000
```

### Health

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/` | Public | Basic API health response. |

### Users

Mounted at `/api/users`.

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `POST` | `/register` | Public | Register a user. Supports `profileImage`, `licenseDocument`, and up to 10 `portfolioPhotos` files. |
| `POST` | `/login` | Public | Log in and receive a JWT. |
| `GET` | `/tradesmen` | Public | List tradesmen. |
| `GET` | `/clients` | Public | List clients. |
| `GET` | `/tradesmen/filter` | Public | Filter tradesmen with query parameters. |
| `POST` | `/tradesmen/filter` | Public | Filter tradesmen with a request body. |
| `GET` | `/profile/:id` | Public | Get a full user profile by ID. |
| `GET` | `/me` | User | Get the authenticated user's profile. |
| `GET` | `/clients/:clientId/profile` | User | Tradesman view of a client profile. |
| `PUT` | `/change-password` | User | Change authenticated user's password. |
| `PUT` | `/profile` | User | Update profile, optionally with `profileImage`. |
| `PUT` | `/profile/update` | User | Update tradesman profile and portfolio photos. |
| `GET` | `/` | Public | List all users. |
| `GET` | `/:id` | Public | Get user by ID. |
| `DELETE` | `/:id` | User | Delete a user. |
| `POST` | `/forgot-password` | Public | Send password reset email. Body includes `email`. |
| `POST` | `/reset-password/:token` | Public | Reset password. Body includes `newPassword`. |

### Google Authentication

Mounted at `/api/auth`.

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/google` | Public | Start Google OAuth web login. |
| `GET` | `/google/callback` | Public | Google OAuth callback. |
| `POST` | `/google/mobile` | Public | Google login for mobile clients. |

### Hiring, Jobs, and Reviews

Mounted at `/api/hire`.

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `POST` | `/request` | User | Client sends a hire request. |
| `POST` | `/respond` | User | Tradesman accepts or rejects a hire request. |
| `POST` | `/request-complete` | User | Tradesman requests job completion. |
| `POST` | `/confirm-complete` | User | Client confirms or rejects job completion. |
| `GET` | `/pending-complete` | User | Check pending completion status. |
| `GET` | `/status/:userId` | User | Get latest hire status for a conversation. |
| `GET` | `/my` | User | Get authenticated user's jobs. |
| `GET` | `/client/bookings` | User | Get client bookings. |
| `POST` | `/review` | User | Add a review. |
| `GET` | `/review/pending` | User | Get pending reviews. |

### Travel Plans

Mounted at `/api/locations`.

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `POST` | `/` | User | Create a travel plan. |
| `GET` | `/my` | User | Get authenticated user's travel plans. |
| `PUT` | `/my` | User | Update authenticated user's active travel plan. |
| `DELETE` | `/:id` | User | Delete a travel plan. |
| `GET` | `/tradesman/:tradesmanId` | Public | Get a tradesman's public location/profile data. |

### Live Location

Mounted at `/api/location`.

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `POST` | `/live-update` | User | Update authenticated tradesman's live location. |

Live location can also be updated over Socket.IO with `live-location:update`.

### Matches

Mounted at `/api/matches`.

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/my-alerts` | User | Get matches between tradesman routes and client alerts. |
| `GET` | `/my-route` | User | Get route matches for the authenticated user. |

### Client Trade Alerts

Mounted at `/api/client-trade-alerts`.

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `POST` | `/` | User | Create a client trade alert. |
| `GET` | `/my` | User | Get authenticated user's trade alerts. |
| `PUT` | `/:id` | User | Update a trade alert. |
| `PATCH` | `/:id/toggle` | User | Enable or disable a trade alert. |
| `DELETE` | `/:id` | User | Delete a trade alert. |

### Chat

Mounted at `/api/chat`.

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `POST` | `/send` | User | Send a direct message. |
| `GET` | `/conversation/:userId` | User | Get conversation with another user. |
| `GET` | `/list?page=1&limit=20` | User | Get paginated chat list. |
| `PUT` | `/mark-read` | User | Mark messages as read. |

### Portfolio

Mounted at `/api/user`.

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `POST` | `/portfolioPhotos` | User | Upload up to 10 portfolio photos using the `photos` field. |
| `GET` | `/portfolioPhotos` | User | Get authenticated user's portfolio. |
| `DELETE` | `/portfolioPhotos/:index` | User | Delete a portfolio photo by index. |

### Trades

Mounted at `/api/trades`.

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/` | Public | List all trade types. |
| `GET` | `/search` | Public | Search trade types by name or category. |

### Notifications

Mounted at `/api/notifications`.

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `POST` | `/save-token` | User | Save Firebase device token. |
| `GET` | `/?limit=20&cursor=123&unreadOnly=false` | User | Fetch notification inbox. |
| `GET` | `/unread-count` | User | Fetch unread notification count. |
| `PATCH` | `/read-all` | User | Mark all notifications as read. |
| `PATCH` | `/:id/read` | User | Mark one notification as read. |

### Subscriptions

Mounted at `/api/subscriptions`.

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/plans` | Public | List subscription plans. |
| `GET` | `/success` | Public | Stripe checkout success page. |
| `GET` | `/cancel` | Public | Stripe checkout cancel page. |
| `POST` | `/webhook` | Stripe | Stripe webhook endpoint. Uses raw request body. |
| `GET` | `/my` | User | Get authenticated user's subscription. |
| `POST` | `/checkout-session` | User | Create Stripe checkout session. |
| `POST` | `/upgrade-plan` | User | Upgrade current plan. |
| `POST` | `/downgrade-plan` | User | Downgrade current plan. |
| `POST` | `/cancel-subscription` | User | End the current subscription. Defaults to ending at the current period end; send `{ "cancelImmediately": true }` to cancel immediately. |
| `POST` | `/mobile/setup-intent` | User | Create mobile setup intent. |
| `POST` | `/mobile/create-subscription` | User | Create mobile subscription. |

Configured plans:

| Key | Name | Monthly Price | Currency | Travel Plan Stop Limit |
| --- | --- | --- | --- | --- |
| `basic` | Basic | 19 | AUD | 2 |
| `make_money` | Make Money | 44 | AUD | 5 |
| `pro` | Pro | 99 | AUD | 10 |

### Admin

Mounted at `/api/admin`.

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `POST` | `/register` | Public | Register an admin. |
| `POST` | `/login` | Public | Log in as admin. |
| `GET` | `/tradesmen/pending` | Admin | List pending tradesman approvals. |
| `POST` | `/tradesmen/:userId/approve` | Admin | Approve a tradesman. |
| `POST` | `/tradesmen/:userId/reject` | Admin | Reject a tradesman. |
| `GET` | `/tradesmen/:userId` | Admin | Get one tradesman approval record. |
| `GET` | `/dashboard/overview` | Admin | Dashboard overview stats. |
| `GET` | `/dashboard/analytics` | Admin | Dashboard analytics. |
| `GET` | `/reports/users` | Admin | Users report. |
| `GET` | `/reports/users/export` | Admin | Export users report as CSV. |
| `GET` | `/reports/subscriptions` | Admin | Subscriptions report. |
| `GET` | `/reports/subscriptions/export` | Admin | Export subscriptions report as CSV. |

## Socket.IO

Socket.IO is initialized in `index.js` through `socket.init(server)`. Connections require a valid JWT.

### Client Connection

```js
import { io } from "socket.io-client";

const socket = io("http://localhost:5000", {
  auth: {
    token: "USER_JWT"
  }
});
```

### Events

| Event | Direction | Description |
| --- | --- | --- |
| `register` | Client to server | Registers the socket for the authenticated user. Payload may include `userId`, but the JWT user ID is preferred. |
| `join-room` | Client to server | Joins a room by `roomId`. |
| `send-message` | Client to server | Sends a direct message. Payload includes `receiverId` and `message`. Supports acknowledgement callback. |
| `receive-message` | Server to client | Delivers a saved chat message to sender and receiver sockets. |
| `message-received` | Client to server | Logs a client-side message receipt acknowledgement. |
| `live-location:update` | Client to server | Updates live location. Payload includes `latitude` and `longitude`. Throttled to one processed update every 5 seconds per user. |

## File Uploads

Uploads use Multer and image conversion uses Sharp.

Common multipart fields:

- `profileImage`: single profile image
- `licenseDocument`: single license document
- `portfolioPhotos`: up to 10 files during registration or tradesman profile update
- `photos`: up to 10 files for portfolio upload endpoint

Local files are stored under `LOCAL_UPLOAD_ROOT`, defaulting to `uploads`, and served publicly from `LOCAL_UPLOAD_PUBLIC_BASE`, defaulting to `/uploads`.

## Background Jobs

The main process starts these recurring jobs from `index.js`:

- Travel plan status refresh, controlled by `TRAVEL_PLAN_STATUS_REFRESH_INTERVAL_MS`.
- Notification cleanup, controlled by `NOTIFICATION_CLEANUP_INTERVAL_MS` and `NOTIFICATION_RETENTION_DAYS`.
- Match reminder email job, controlled by `EMAIL_REMINDER_RUN_HOUR`, `EMAIL_REMINDER_RUN_MINUTE`, and `EMAIL_REMINDER_RUN_ON_START`.

## Stripe Setup

1. Set `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, and `STRIPE_WEBHOOK_SECRET`.
2. Seed subscription products/prices if required:

```bash
npm run subscriptions:seed
```

3. Configure the Stripe webhook endpoint:

```text
POST https://your-api-domain.com/api/subscriptions/webhook
```

The webhook route is registered before `express.json()` so Stripe signature verification can use the raw body.

## Email Setup

SMTP is used for password reset emails, test emails, and reminder emails.

Test email delivery:

```bash
npm run email:test
```

Or provide a recipient:

```bash
node scripts/sendTestEmail.js recipient@example.com
```

## Development Workflow

Recommended local flow:

```bash
npm install
npm run db:check
npm run db:migrate
npm run dev
```

Before deploying schema changes:

```bash
npm run db:migrate:status
```

When changing chat data structures, use the dry-run scripts before running mutating scripts:

```bash
npm run chat:backfill:dry
npm run chat:migrate:conversation-id:dry
```

## Deployment Checklist

- Set production `.env` values.
- Use a strong `JWT_SECRET` and `SESSION_SECRET`.
- Run `npm install --omit=dev` if dev dependencies are not needed.
- Run pending migrations with `npm run db:migrate`.
- Configure Stripe webhook URL and secret for the production domain.
- Configure Google OAuth callback URL for the production domain.
- Configure SMTP credentials and verify email delivery.
- Ensure `uploads/` or the configured local upload directory is persisted.
- Put the API behind HTTPS.
- Configure CORS for trusted frontend origins if this API is exposed publicly.

## Troubleshooting

### Database connection fails

- Confirm MySQL is running.
- Confirm `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, and `DB_PASS`.
- Run `npm run db:check`.
- Ensure migrations have been applied with `npm run db:migrate`.

### JWT protected routes return unauthorized

- Confirm the `Authorization` header is exactly `Bearer <token>`.
- Confirm `JWT_SECRET` is the same value used when the token was generated.
- Confirm the token is not expired.

### Stripe webhooks fail

- Confirm the webhook endpoint is `/api/subscriptions/webhook`.
- Confirm `STRIPE_WEBHOOK_SECRET` matches the configured Stripe endpoint.
- Do not move the webhook route below `express.json()` unless raw-body handling is preserved.

### Emails do not send

- Confirm all SMTP variables are present.
- For Gmail, use an app password, not the regular account password.
- Check whether the hosting provider blocks SMTP ports `465` or `587`.

### Upload URLs do not load

- Confirm files exist under `LOCAL_UPLOAD_ROOT`.
- Confirm the public URL starts with `LOCAL_UPLOAD_PUBLIC_BASE`, default `/uploads`.
- Confirm the server process has read/write permission for the upload directory.

## License

No license file is currently included in this repository. Add one before public distribution.
