# Step 10 - Chat And Socket Stabilization

This document explains the chat/socket stabilization completed after the audit.

## Changes Implemented

### Shared Chat Send Path

REST and socket message sends continue to use:

```text
services/chatService.js
```

This keeps:

- message persistence
- conversation summary updates
- unread count updates
- push-after-commit behavior

in one shared path.

### Chat Message Validation

Added `CHAT_MAX_MESSAGE_LENGTH`, defaulting to:

```text
5000
```

Overlong messages are rejected by the shared service, so both REST and socket sends inherit the same guard.

Optional env override:

```env
CHAT_MAX_MESSAGE_LENGTH=5000
```

### Push-Only Chat Behavior

Chat notifications still use push-only behavior and are not persisted in the generic notification inbox.

This avoids duplicating chat state across:

- messages
- conversation participants
- notification inbox

### Socket Live-Location Validation

Socket live-location updates now use the same validation helper as REST:

```text
utils/liveLocationValidation.js
```

Rules:

- authenticated socket user required
- caller must be a tradesman
- latitude/longitude required
- latitude/longitude must be valid numbers
- latitude must be `-90..90`
- longitude must be `-180..180`

## Test Coverage

Covered in `tests/security-lockdown.test.js`:

- socket live-location validation matches REST rules
- shared chat service rejects overlong messages
- REST chat send uses shared service
- chat push remains push-only and does not create inbox notifications

## Remaining Follow-Ups

- Add a shared Socket.IO adapter, such as Redis, before scaling sockets across multiple EC2 instances.
- Add end-to-end socket tests with a Socket.IO client if real-time delivery needs automated browser/device coverage.
- Decide whether to remove the legacy `server.js` socket entry in the final dead-code cleanup.

