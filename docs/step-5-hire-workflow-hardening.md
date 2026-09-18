# Step 5 - Hire Workflow Hardening

This document explains the hire workflow changes completed after the audit.

## Changes Implemented

### Explicit Status Rules

The hire workflow now treats these statuses as intentional states:

- `pending`
- `accepted`
- `rejected`
- `completed`
- `cancelled`

Active hires are:

- `pending`
- `accepted`

Terminal hires are:

- `rejected`
- `completed`
- `cancelled`

### Hire Request

- Only clients can create hire requests.
- `tradesmanId` must be a positive integer.
- `jobDescription` is required.
- `jobDescription` is capped at 2000 characters.
- Target must be an approved tradesman.
- Duplicate active hires between the same client and tradesman are blocked.

### Accept / Reject

- Only tradesmen can accept or reject.
- `hireId` must be a positive integer.
- `action` must be `accept` or `reject`.
- Only pending hires can be accepted or rejected.

### Cancel Path

Added:

```text
POST /api/hire/cancel
```

Rules:

- Only the client or tradesman on the hire can cancel it.
- Completed, rejected, and already-cancelled hires cannot be cancelled.
- Hires with a pending completion request cannot be cancelled until completion is resolved.
- Optional cancel reason is capped at 500 characters.

### Completion Flow

- Only tradesmen can request completion.
- Only clients can confirm completion.
- Completion can only be confirmed when the hire is accepted and `requestCompletion=true`.
- Completed hires are protected from further transition through cancel/respond.

## Test Coverage

Covered in `tests/security-lockdown.test.js`:

- tradesman callers cannot create hire requests
- approved tradesman requirement
- pending-only accept/reject
- accepted hire cancellation
- completed hire cannot be cancelled

