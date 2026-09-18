# Step 2 - Security Lockdown

This document explains the first security changes applied after the backend audit.

## Changes Implemented

### Google Login

- `POST /api/auth/google/mobile` now requires a Google ID token.
- The backend verifies the token with Google before trusting the email.
- The token audience is checked against `GOOGLE_CLIENT_ID` when configured.
- Google users are created or updated with `googleId`, `provider`, `isVerified`, and `profileImage`.
- Issued JWTs now include `role`.
- Web Google callback URL now supports `GOOGLE_CALLBACK_URL`.
- Web Google profile image writes to `profileImage`, not `profilePicture`.

### Admin Registration

- `POST /api/admin/register` is no longer always public.
- The first admin can still be bootstrapped when there are zero admins.
- After an admin exists, creating another admin requires a valid admin token.
- Admin registration responses no longer return the password hash.

### User Data Exposure

- User response serialization now strips:
  - `password`
  - `resetPasswordToken`
  - `resetPasswordExpires`
- Client list responses now pass through the same sanitizer.
- Existing media URL normalization behavior is preserved.

### User Deletion Scope

- `DELETE /api/users/:id` now allows:
  - a user deleting their own account
  - an admin token deleting a user
- Other authenticated users receive `403`.

### Profile Self-Approval

- `PUT /api/users/profile` no longer accepts `isApproved` from the request body.
- Tradesman approval remains an admin workflow.

### Forgot Password

- `POST /api/users/forgot-password` no longer returns the reset link.
- The reset link is sent by email.
- Missing accounts receive the same generic success message to reduce account enumeration.
- `FRONTEND_URL` is required for reset link generation.

### CORS And Socket Origins

- Express CORS no longer allows every origin by default.
- Socket.IO CORS no longer allows every origin by default.
- Allowed origins come from `CORS_ALLOWED_ORIGINS`.
- In non-production without `CORS_ALLOWED_ORIGINS`, localhost development origins are allowed.
- In production without `CORS_ALLOWED_ORIGINS`, browser origins are blocked.

### Rate Limiting

- Added lightweight in-memory rate limiting for:
  - user registration
  - user login
  - forgot/reset password
  - mobile Google login
  - admin login
  - admin registration
- This protects a single API instance. Move this to Redis or another shared store before horizontal scaling.

### Hire Workflow Guards

- Only clients can create hire requests.
- Hire targets must be approved tradesmen.
- Only tradesmen can accept or reject hire requests.
- Tradesmen can only accept/reject pending hires.
- Only tradesmen can request completion.
- Only clients can confirm completion.
- Only clients can view pending completion requests.
- Job listing rejects unsupported roles.

## New Or Updated Environment Variables

```env
CORS_ALLOWED_ORIGINS=https://app.example.com,https://admin.example.com
GOOGLE_CALLBACK_URL=https://api.example.com/api/auth/google/callback
GOOGLE_CLIENT_ID=your-google-client-id
FRONTEND_URL=https://app.example.com
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=your-email@example.com
SMTP_PASS=your-smtp-password
SMTP_FROM="Touring Trades <your-email@example.com>"
```

## Files Changed

- `app.js`
- `socket.js`
- `utils/securityConfig.js`
- `middlewares/rateLimitMiddleware.js`
- `controllers/userController.js`
- `controllers/googleAuthController.js`
- `controllers/AdminController/adminAuthController.js`
- `controllers/hireController.js`
- `config/passport.js`
- `routes/userRoutes.js`
- `routes/googleRoutes.js`
- `routes/AdminRoute/adminRoutes.js`

## Remaining Security Follow-Ups

- Add database-level unique email enforcement with a migration.
- Move rate limiting to a shared store before running multiple API instances.
- Add security headers with a package such as `helmet`.
- Review public directory/profile endpoints and decide which should require auth.
- Add tests for auth, password reset, admin registration, deletion scope, and hire status transitions.
- Ensure Firebase credentials and all secrets stay out of git.

