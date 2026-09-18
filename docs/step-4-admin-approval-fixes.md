# Step 4 - Admin And Approval Fixes

This document explains the admin approval hardening completed after the audit.

## Changes Implemented

### Pending Search MySQL Fix

- Replaced Postgres-only `Op.iLike` with MySQL-compatible `Op.like`.
- Pending tradesman search now works against MySQL.
- `tradeTypeId` is validated as a positive integer.

### Approval Controller Consolidation

- Removed unused legacy controller:
  - `controllers/approvalController.js`
- Active routes continue to use:
  - `controllers/tradesmanApprovalController.js`

### Admin-Only Approval Routes

- Existing admin middleware remains enforced on approval routes.
- Approval controller now validates `userId` as a positive integer.
- Queries require the target user to actually be a `tradesman`.

### Approval State Rules

- Already-approved tradesmen cannot be approved again.
- Already-approved tradesmen cannot be rejected through the pending rejection endpoint.
- Rejection requires a non-empty reason.
- Rejection reason is capped at 500 characters.

### Approval Readiness Validation

Before approval, a tradesman profile must include:

- `tradeTypeId`
- `tradeType`
- `businessName`
- `shortBio`
- `licenseNumber`
- `licenseExpiry`
- `licenseDocument`
- `portfolioPhotos`

If any are missing, the API returns `400` with `missingFields`.

### Response Hygiene

- Admin approval/detail responses sanitize nested user data.
- Password and password-reset fields are not returned.

## Test Coverage

Covered in `tests/security-lockdown.test.js`:

- pending search works with MySQL-compatible operators
- incomplete tradesman approval is rejected
- rejection requires a reason
- admin tradesman detail response does not expose password fields

## Remaining Follow-Ups

- Add email notifications for approval/rejection if required by product.
- Add audit log table for admin approval actions.
- Decide whether rejected tradesmen can be resubmitted through a dedicated endpoint.

