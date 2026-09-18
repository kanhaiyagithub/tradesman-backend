# Step 3 - Auth And User Cleanup

This document explains the auth/user cleanup completed after the first security lockdown.

## Changes Implemented

### Password Login For Google Users

- Password login now handles users with no password hash.
- Google-only users receive a clear response telling them to continue with Google login.
- This prevents `bcrypt.compare` from breaking when `user.password` is empty.

### Google User Fields

- Google web login now writes the profile image to `profileImage`.
- `GOOGLE_CALLBACK_URL` can be configured from the environment.
- Google mobile login verifies a real Google ID token before creating/updating users.
- Google login JWTs include `role` so role-guarded routes work consistently.

### User Response Hygiene

- User serialization strips sensitive fields:
  - `password`
  - `resetPasswordToken`
  - `resetPasswordExpires`
- This now applies to list/profile-style serializers used by the user endpoints.

### Database Email Uniqueness

- Migration `20260918-0007-user-email-unique.js` adds a unique index on `Users.email`.
- The migration refuses to apply the unique index if duplicate emails already exist.
- No demo user seed data is created by this migration.

### Removed Dead Helpers

- Removed unused JWT helper duplicates:
  - `utils/jwt.js`
  - `utils/generateToken.js`

## Test Coverage

Covered in `tests/security-lockdown.test.js`:

- seeded user/admin login
- fake Google mobile login rejection
- sensitive user fields not leaking
- delete-user scope protection
- self-approval prevention

## Remaining Follow-Ups

- Consider moving all token signing to one shared helper in a later cleanup.
- Add stricter request validation for registration/login body shape.
- Decide whether public user directory endpoints should remain public.
