# API contract

The contract the frontend is built from, as OpenAPI 3.1: [openapi.yaml](openapi.yaml). It is the docs-keeper's job to keep it equal to the validators and controllers: every route, its request and response shapes, status codes and errors. Until the contract is frozen (layer 11 of the [build order](../design.md#13-build-order)), a layer may change what it added before. Current version: 0.2.0 (layer 2).

## Conventions

- Every path starts with `/v1`. Requests and responses are JSON.
- Success: `{ success: true, message, data }`. Login and a password change also carry a top-level `token`.
- Error: `{ message }`, plus `details` (a list of strings) for validation errors. Only the error middleware writes error responses, so every error has this shape, a 404 and a 429 included.
- Protected paths need `Authorization: Bearer <token>`, with the token from login. The scheme name is case-insensitive; anything after the token makes the header invalid.
- Every response carries `Cache-Control: no-store` and the other security headers of `securityHeaders.middleware.ts`.
- Limits answer 429 with `RateLimit` and `RateLimit-Policy` headers (IETF draft 8 form) and `Retry-After`.

## Authentication

- `POST /v1/auth/login` returns the user and a token (HS256, 1 hour by default). There is no refresh token: when a request answers 401, the user logs in again.
- The token carries `sub` (user id), `ver` (version of the user's sessions), `iss`, `aud`, `iat` and `exp`, and no role. The server reads the role and the status from the database on every request, so a promotion, a demotion or a disabled account applies on the very next request.
- A token stops working before it expires when the user logs out (`POST /v1/auth/logout` ends every session of the account), changes the password (the answer carries a new token) or is disabled, and when the account is deleted. All of those are the same 401 "Invalid or expired authentication token": the client cannot tell the reasons apart and sends the user to the login screen.
- Keep the token in memory, not in storage other scripts can read, and clear it on a 401.
- There is no self-registration. An admin creates accounts (`POST /v1/users`); the first admin comes from a script the owner runs.

## Endpoints today

| Method and path | Access | Answers |
|---|---|---|
| `GET /v1/health` | Public | `200` `{ success: true, message: "Health check completed", data: { status, database, ollama } }`; `429` over 30 checks per minute per address |
| `POST /v1/auth/login` | Public | Body `{ email, password }`. `200` `{ success, message: "Logged in successfully", data: User, token }`; `400` validation; `401` "Invalid email or password"; `403` "This account is disabled" (only with the right password); `429`; `503` |
| `POST /v1/auth/logout` | Token | No body. `200` `{ success, message: "Logged out successfully" }` (no `data`); `401`; `429`; `503` |
| `GET /v1/users/me` | Token | `200` `{ success, message: "Current user retrieved successfully", data: User }` |
| `PATCH /v1/users/me/password` | Token | Body `{ currentPassword, newPassword }` (new: 8 to 64 characters). `200` `{ success, message: "Password changed successfully", data: User, token }`; `400` validation or "Current password is incorrect"; `409` "The password was changed by another request, please try again"; `429` over 5 attempts per 15 minutes |
| `POST /v1/users` | Admin | Body `{ email, password, role? }` (`role` is `user` or `admin`, `user` when missing). `201` `{ success, message: "User created successfully", data: User }`; `400`; `403`; `409` "Email is already registered"; `429` over 20 attempts per hour |
| `PATCH /v1/users/:id` | Admin | Body with `role` and/or `status` (`active` or `disabled`), at least one. `200` `{ success, message: "User updated successfully", data: User }`; `400`; `403`; `404` "User not found"; `409` "You cannot change your own role or status" |

`User` is `{ id, email, role, status, createdAt }`; the password and the session version are never returned. Emails are trimmed, lowercased and normalized (Unicode NFC), at most 254 characters. Passwords are not trimmed; new ones have 8 to 64 characters. Every endpoint answers `401` without a valid token, except the public ones, and `500` on an unexpected failure.

`status` of the health report is `ok`, `degraded` (Ollama down or a required model missing) or `down` (database down); `database` and `ollama` are `up` or `down`. The endpoint answers `200` in all three cases: only a request that gets no answer at all means the API is offline. A model name or an error is never part of the response.

## Every request, in order

| Step | Situation | Status | `message` |
|---|---|---|---|
| 1 | Over 300 requests per minute from one address (any path) | 429 | Too many requests, please try again later |
| 2 | The database cannot be reached, or the server has not finished checking it since it started (every `/v1` path except health, unknown paths included) | 503 | The database is not available, please try again later |
| 3 | Protected path: no `Authorization` header, or not `Bearer <token>` | 401 | Authentication token is missing |
| 3 | Protected path: forged, expired or otherwise invalid token | 401 | Invalid or expired authentication token |
| 4 | Protected path: over the per-user limit (120 per minute by default, per user and session) | 429 | Too many requests, please try again later |
| 5 | Protected path: the session ended (logout, password change), the account is disabled or no longer exists | 401 | Invalid or expired authentication token |
| 5 | Admin path, user is not an admin | 403 | You do not have permission to perform this action |
| 6 | Valid token, path does not exist | 404 | Route not found |

The token is checked before the path, so an unknown path without a token is a 401. A path outside `/v1` is a 404 without a token. An unexpected failure is a 500 with `{ message: "Internal server error" }`. A database that cannot be reached during a request (a restart of PostgreSQL, for example) is a 503 with the same message as step 2; the 503 passes by itself, so the client may try again later.

The role needed by a path is checked against the database on every request. On the admin routes, the order is: token, per-user limit, account check, role (403), then the route's own limit, the body and its validation (400).
