# API Test Suite — Postman

Manual test-design and automated regression suite for the To-Do List App backend, built in Postman during a dedicated code-review and API-testing pass on the `code-review/server-refactor` branch. Every request body, environment variable, and assertion in this collection was hand-written and reasoned through individually — this was not generated from an OpenAPI spec.

> Full endpoint reference (request/response shapes, status codes): see [`API_DOCUMENTATION.md`](../API_DOCUMENTATION.md).

---

## Running this suite

1. Import `To-Do-App-API-Test.postman_collection.json` and the accompanying environment file into Postman.
2. Set `base_url` in the environment (defaults to `http://localhost:3000`).
3. Run **Auth → Signup (Owner)** and **Auth → Signup (Attacker)** once, to create the two test accounts the suite depends on.
4. Run **Auth → Login (Owner)** and **Auth → Login (Attacker)** — these auto-populate `token_owner` and `token_attacker` in the environment via post-response scripts.
5. Run **Tasks → Create Task (Owner)** to populate `task_id`.
6. From there, individual folders can be run independently or via the Collection Runner.

`token_owner` and `token_attacker` are stored as `secret`-type environment variables and are not committed with real values.

---

## Structure

```
Auth/
  Signup, Login — positive and negative cases
Tasks/
  Positive/   — one happy-path request per route
  Negative/   — missing-field, malformed-value, nonexistent-ID cases
  Security/   — IDOR-style ownership tests, one per mutating route
Push/
  Subscribe — positive and negative cases
  Send      — authentication-bypass finding
```

---

## Testing approach

### Positive coverage
Every route has at least one request exercising its documented success path, with assertions on both status code and response shape.

### Negative coverage
Organized by category rather than duplicated per route, to keep assertions meaningful rather than repetitive:
- **Missing required fields** — each field validated by the server (`text`, `scheduled_at`, `snooze_until`, `endpoint`, `keys.p256dh`, `keys.auth`) is tested by omission, individually.
- **Malformed-but-present values** — e.g. a non-empty, incorrectly formatted `scheduled_at`.
- **Nonexistent resource IDs** — a well-formed but never-created `task_id`, to confirm the "not found" path behaves correctly independent of any ownership question.
- **Authentication failures** — no `Authorization` header, and a syntactically invalid token, tested once against a representative protected route (`GET /tasks`). Since every protected route shares the same `verifyToken` middleware by reference, this is treated as coverage of the middleware itself rather than duplicated per route.

### Security / IDOR testing
The core of this suite. Every mutating `/tasks` route (`PUT` text update, `toggle`, `snooze`, `stop`, `DELETE`) is tested with a request from **`token_attacker`** targeting a task created by **`token_owner`**. Each test asserts two independent facts:

1. **The attacker's own response** — status code should reflect that the operation was not authorized to affect this resource (`404`, per this API's design — see `API_DOCUMENTATION.md` for why 404 rather than 401/403 was chosen).
2. **The actual data state**, verified via a *separate, owner-authenticated* request fired from inside the test script (`pm.sendRequest`, using `token_owner`) — confirming the resource was genuinely untouched, not just that the response code looked right.

Checking both matters: a status code alone only proves what the server *claims* happened, not what actually happened in the database. Early in this suite's development, the DELETE route returned `200` with a "Deleted" message while the row remained completely intact — a response-only check would have missed that entirely.

---

## Key findings

### 1. Silent no-op mutations reported as success (Fixed)
`DELETE /tasks/:id`, `PUT /tasks/:id`, `PUT /tasks/:id/toggle`, `PUT /tasks/:id/snooze`, and `PUT /tasks/:id/stop` all executed a SQL statement filtered by `WHERE id = ? AND user_id = ?` but never inspected `affectedRows` before responding. A request that matched zero rows — because the resource belonged to a different user, or didn't exist at all — still received an unconditional `200` success response.

This was found and reproduced via the IDOR tests described above, confirmed with a working reproduction (attacker DELETE → `200 Deleted` → owner's task list still showed the task), then fixed by adding an `affectedRows === 0` check returning `404` before the success response on all five routes.

**Design decision:** the same `404` and message is returned whether the resource doesn't exist or belongs to someone else — deliberately unified, to avoid letting an unauthorized caller distinguish "this ID is real but not yours" from "this ID doesn't exist," which would otherwise let them enumerate valid resource IDs.

### 2. Push subscription schema allowed silent overwrites across users (Fixed)
`push_subscriptions` was intended to enforce uniqueness on `(user_id, endpoint)` together — the `CREATE TABLE` statement in source even said so — but the live table's actual constraint was a single-column unique key on `endpoint` alone. Two different users subscribing with a matching `endpoint` value collided against this key, and `ON DUPLICATE KEY UPDATE` silently overwrote the first subscriber's row rather than creating a second one.

Found while diagnosing why scheduled notifications weren't firing for a second test user — direct inspection of `push_subscriptions` showed only one row ever existed regardless of how many users subscribed. Confirmed via `SHOW CREATE TABLE`, fixed live with `ALTER TABLE ... DROP INDEX unique_endpoint`, then `ADD UNIQUE KEY ux_user_endpoint (user_id, endpoint(255))`.

### 3. `scheduled_at` format is not validated (Open)
`POST /tasks` checks that `scheduled_at` is *present* but not that it's a validly formatted datetime. A garbage string (e.g. `"hello"`) passes validation, is passed unmodified to the `INSERT`, and fails only when MySQL rejects it as an invalid `DATETIME` — surfacing a generic `500` instead of a client-actionable `400`. Flagged, not yet fixed.

### 4. `/push/send` had no authentication (Fixed)
Confirmed via a request with no `Authorization` header at all, containing a real (captured) subscription payload: the server responded `200 { "ok": true }` and attempted delivery. This route was not called anywhere in the actual notification flow — real reminders go through a separate cron scheduler that calls the push library directly — confirming it was a leftover manual-debugging endpoint from earlier development. Resolved by removing the route entirely rather than retrofitting authentication onto an endpoint the product doesn't need.

---

## Deliberately failing tests

A small number of tests in this suite are expected to fail and are left that way on purpose, documenting known, unresolved issues rather than being "fixed" by loosening the assertion. A green suite is not the goal — an accurate one is. Each deliberately-failing test is commented with what it's proving and why it hasn't been resolved yet.

---

## Explicitly out of scope (this pass)

- **SQL injection testing** — deferred; requires dedicated setup and threat-modeling rather than being folded into a general negative-test pass.
- Load/performance testing.
- Full negative coverage on malformed values beyond `scheduled_at` (e.g. `priority` outside the expected enum) — only the highest-value cases were pursued given time constraints; flagged as a natural extension of this suite.
