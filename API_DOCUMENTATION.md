# To-Do List App — API Documentation

A full-stack task manager with JWT authentication, scheduled reminders, and Web Push notifications. This document describes every backend route: what it expects, what it returns, and how ownership/authentication is enforced.

**Base URL (local):** `http://localhost:3000`
**Auth scheme:** Bearer JWT (`Authorization: Bearer <token>`), issued at `/login`, expires after 12 hours.

---

## Table of Contents

- [Authentication](#authentication)
- [Tasks](#tasks)
- [Push Notifications](#push-notifications)
- [Error Response Shape](#error-response-shape)
- [Known Issues / Limitations](#known-issues--limitations)

---

## Authentication

### `POST /signup`

Creates a new user account. Password is hashed with bcrypt before storage.

**Body**
```json
{
  "username": "string",
  "email": "string",
  "password": "string"
}
```

| Status | Condition | Body |
|---|---|---|
| `201` | Account created | `{ "message": "User created" }` |
| `400` | Missing any field | `{ "message": "All fields required" }` |
| `409` | Email already registered | `{ "message": "Email already exist " }` |
| `500` | Unexpected server error | `{ "message": "Server error" }` |

---

### `POST /login`

Authenticates a user and issues a JWT.

**Body**
```json
{
  "email": "string",
  "password": "string"
}
```

| Status | Condition | Body |
|---|---|---|
| `200` | Success | `{ "message": "Login successful", "token": "<jwt>", "user": { "id", "username", "email" } }` |
| `400` | Missing email or password | `{ "message": "Email and password are required" }` |
| `401` | Wrong email **or** wrong password | `{ "message": "Invalid credentials" }` |
| `500` | Unexpected server error | `{ "message": "Server error" }` |

> **Design note:** `401` is intentionally identical whether the email doesn't exist or the password is wrong. This prevents an attacker from using the response to enumerate which emails are registered.

The JWT payload contains `{ id, username }` — this `id` is the source of truth for ownership on every protected route below. It is never read from the request body or URL.

---

## Tasks

All routes below require `verifyToken` middleware:

| Condition | Status | Body |
|---|---|---|
| No `Authorization` header | `401` | `{ "message": "No token provided" }` |
| Header present but token invalid/expired | `403` | `{ "message": "Invalid or expired token" }` |

### `GET /tasks`

Returns every task belonging to the authenticated user. There is no route to fetch a single task by ID — clients fetch the full list and filter client-side.

**Response `200`**
```json
[
  {
    "id": 47,
    "user_id": 10,
    "text": "string",
    "scheduled_at": "2026-08-10 14:00:00",
    "date": null,
    "time": null,
    "snooze_until": null,
    "last_notified_at": null,
    "notifications_paused": 0,
    "priority": "low | medium | high",
    "completed": 0,
    "created_at": "2026-08-06 05:23:36"
  }
]
```
> `date` and `time` are legacy columns from an earlier schema iteration and are always `null` — the app consolidated to a single `scheduled_at` `DATETIME` column. They are harmless but unused.

### `POST /tasks`

Creates a task for the authenticated user. `user_id` is taken from the JWT — it is not, and cannot be, supplied by the client.

**Body**
```json
{
  "text": "string (required)",
  "scheduled_at": "YYYY-MM-DD HH:MM:SS (required)",
  "priority": "low | medium | high (optional, defaults to \"low\")"
}
```

| Status | Condition | Body |
|---|---|---|
| `201` | Created | the created task object |
| `400` | Missing `text` | `{ "message": "Task text required" }` |
| `400` | Missing `scheduled_at` | `{ "message": "scheduled_at required" }` |
| `500` | Insert failed (including malformed-but-present `scheduled_at` — see Known Issues) | `{ "message": "Error adding task" }` |

### `PUT /tasks/:id`

Updates `text`, `scheduled_at`, and `priority` on a task. Only succeeds if the task belongs to the authenticated user.

**Body**
```json
{ "text": "string", "scheduled_at": "YYYY-MM-DD HH:MM:SS", "priority": "low | medium | high" }
```

| Status | Condition | Body |
|---|---|---|
| `200` | Updated | `{ "message": "Task updated" }` |
| `404` | Task doesn't exist, **or** exists but belongs to a different user | `{ "message": "Object not found" }` |
| `500` | Unexpected error | `{ "message": "Error while updating tasks" }` |

### `PUT /tasks/:id/toggle`

Flips `completed` (0 → 1 or 1 → 0). No body required.

| Status | Condition | Body |
|---|---|---|
| `200` | Toggled | `{ "message": "Toggled" }` |
| `404` | Not found / not owned by caller | `{ "message": "Object not found" }` |
| `500` | Unexpected error | `{ "message": "Toggle failed" }` |

### `PUT /tasks/:id/snooze`

Sets `snooze_until` and clears `last_notified_at` so the reminder fires again.

**Body**
```json
{ "snooze_until": "YYYY-MM-DD HH:MM:SS (required)" }
```

| Status | Condition | Body |
|---|---|---|
| `200` | Snoozed | `{ "message": "Snoozed" }` |
| `400` | Missing `snooze_until` | `{ "message": "snooze_until required" }` |
| `404` | Not found / not owned by caller | `{ "message": "Object not found" }` |
| `500` | Unexpected error | `{ "message": "Snooze failed" }` |

### `PUT /tasks/:id/stop`

Sets `notifications_paused = 1`, silencing future reminders for the task without deleting or completing it. No body required.

| Status | Condition | Body |
|---|---|---|
| `200` | Stopped | `{ "message": "Notifications stopped" }` |
| `404` | Not found / not owned by caller | `{ "message": "Object not found" }` |
| `500` | Unexpected error | `{ "message": "Database error" }` |

### `DELETE /tasks/:id`

Deletes a task. No body required.

| Status | Condition | Body |
|---|---|---|
| `200` | Deleted | `{ "message": "Deleted" }` |
| `404` | Not found / not owned by caller | `{ "message": "Object not found" }` |
| `500` | Unexpected error | `{ "message": "Delete failed" }` |

> **Ownership enforcement on all five mutating routes above:** every query filters with `WHERE id = ? AND user_id = ?`, where `user_id` comes from the verified JWT. A request against another user's task cannot match any row, so it silently affects zero rows — the route checks `result.affectedRows` and returns `404` rather than a false `200`. **The same `404` is returned whether the task doesn't exist at all or exists but belongs to someone else** — this is deliberate, to avoid leaking which task IDs are real to an unauthorized caller (see `/login`'s identical reasoning above).

---

## Push Notifications

### `GET /vapid-public-key`

Returns the server's VAPID public key as plain text, used by the frontend to register for push notifications. No auth required (public key, not a secret).

### `POST /subscribe`

Saves (or updates) a push subscription for the authenticated user. Requires `verifyToken`.

**Body**
```json
{
  "endpoint": "string (required)",
  "keys": {
    "p256dh": "string (required)",
    "auth": "string (required)"
  }
}
```

| Status | Condition | Body |
|---|---|---|
| `201` | Saved / updated | `{ "message": "Subscription saved" }` |
| `400` | Missing `endpoint`, `keys`, `keys.p256dh`, or `keys.auth` | `{ "message": "Invalid subscription format" }` |
| `500` | Database error | `{ "message": "Database error" }` |

A user can have multiple subscriptions (e.g. multiple browsers/devices) — uniqueness is enforced on the combination of `user_id` and `endpoint`, not on `endpoint` alone (see Known Issues for the schema bug this required fixing).

### `POST /push/send` — removed

This route previously triggered a push send to an arbitrary `endpoint`/`keys` pair with no authentication. It was originally built as a manual debugging tool while troubleshooting push delivery and was never used by the actual notification flow — real reminders are delivered by a separate cron-based scheduler (`notifier.js`) that calls the `web-push` library directly. Confirmed unused elsewhere and removed entirely (see Known Issues).

---

## Error Response Shape

Error responses are consistently `{ "message": "<human-readable string>" }`, occasionally with an additional `err` field on `/push/send` specifically. There is no machine-readable error code field at this time.

---

## Known Issues / Limitations

Issues found during API testing, listed with status. See `postman/README.md` for how each was verified.

| # | Issue | Severity | Status |
|---|---|---|---|
| 1 | `push_subscriptions` table's unique key was originally single-column (`endpoint` only) instead of composite (`user_id` + `endpoint`), so a second user subscribing with a matching endpoint silently overwrote the first user's row. | High (data integrity) | **Fixed** — table altered to composite key `ux_user_endpoint (user_id, endpoint(255))`. |
| 2 | Five mutating `/tasks` routes returned `200` success even when the query affected zero rows (wrong owner, or already-deleted/nonexistent task), silently misreporting failed operations as successful. | High (security + correctness) | **Fixed** — all five now check `affectedRows` and return `404`. |
| 3 | `POST /tasks` (and `PUT /tasks/:id/snooze`) validate that `scheduled_at` is *present* but not that it's a validly formatted date. A malformed-but-non-empty value passes validation and fails downstream at the database layer, returning a generic `500` instead of a client-actionable `400`. | Medium (input validation) | **Open** — deferred. |
| 4 | `POST /push/send` had no authentication (`verifyToken` was not applied) and took `endpoint`/`keys`/`payload` directly from the request body. Anyone — logged in or not — could trigger a push send to any subscription endpoint they possessed, including one belonging to another user. | High (missing authentication) | **Fixed** — route removed entirely; confirmed unused by the real notification flow, which calls `web-push` directly from `notifier.js`. |
| 5 | The `CREATE TABLE IF NOT EXISTS` statement for `push_subscriptions` in `server.js` contained `user_id(10)` — an invalid prefix-length specifier on an `INT` column (prefix lengths only apply to string/text types), meaning a fresh database created from this code would have reproduced issue #1. | Medium (schema drift) | **Fixed** — source statement corrected to match the live, already-altered schema. |

---

*Backend: Node.js, Express, MySQL (mysql2), JWT, bcrypt, Web Push (VAPID), node-cron. Full test coverage for the routes above is documented in [`postman/README.md`](./postman/README.md).*
