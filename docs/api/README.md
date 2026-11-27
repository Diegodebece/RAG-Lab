# API contract

The contract the frontend is built from, as OpenAPI 3.1: [openapi.yaml](openapi.yaml). It is the docs-keeper's job to keep it equal to the validators and controllers: every route, its request and response shapes, status codes and errors. Until the contract is frozen (layer 11 of the [build order](../design.md#13-build-order)), a layer may change what it added before. Current version: 0.4.0 (layer 4).

## Conventions

- Every path starts with `/v1`. Requests and responses are JSON.
- Success: `{ success: true, message, data }`. Login and a password change also carry a top-level `token`.
- Error: `{ message }`, plus `details` (a list of strings) for validation errors. Only the error middleware writes error responses, so every error has this shape, a 404 and a 429 included.
- Protected paths need `Authorization: Bearer <token>`, with the token from login. The scheme name is case-insensitive; anything after the token makes the header invalid.
- Every response carries `Cache-Control: no-store` and the other security headers of `securityHeaders.middleware.ts`.
- Limits answer 429 with `RateLimit` and `RateLimit-Policy` headers (IETF draft 8 form) and `Retry-After`.
- Error `details` and profile names can hold text a user wrote (an unknown setting's key, a profile name). Render them as text, never as HTML.

## Settings and profiles

- `GET /v1/configuration` lists the eleven settings of the current configuration version with what each accepts, so a form can be built from it. A setting has `allowed` (the only values) or `min` and `max`, and `decimals` for the most decimal places; `kind` is `index` (changing it needs the documents indexed again) or `question`.
- Numbers must be JSON numbers, never text: `"3"` for `topK` is a 400. Nothing is converted, rounded or clamped. A value outside its cap, or with more decimals than `decimals`, is a 400: a client that computes `0.30000000000000004` for `minScore` gets a 400, so round before sending.
- Unknown settings are refused (400, "Unknown setting: <key>"); a setting is never accepted and ignored. Unknown fields in a body are refused too.
- A profile holds only the settings the user set; the rest comes from the default profile. `PATCH` with `settings` replaces the stored object as a whole, and `{}` goes back to the default.
- A profile saved before a cap changed is still listed and readable, with `problems` saying what is wrong with it. It is refused (400 "The configuration is not valid", with every problem in `details`) when it is resolved. Show `problems` to the user and let them fix or delete the profile.
- `POST /v1/configuration/resolve` is a dry run that calls no model. It returns the complete `snapshot` (`version` and the eleven `settings`) and its `hash`, the SHA-256 of the snapshot's canonical JSON. The profile id and the dates are not part of the hash, so the same settings give the same hash whichever profile they came from. The hash identifies a configuration; it is not a secret and proves nothing about who sent it.
- A profile at another configuration version (after a future version change) cannot be changed (409) and cannot be resolved (500); it can be read and deleted.
- Another user's profile is a 404 for everyone, admins included. The same 404 answers an id that is not a UUID.
- Profile bodies are read up to 16 kB; more is a 413 "request entity too large". A user may keep at most `profiles.maxPerUser` profiles (20 by default); the next one is a 409.

## Documents and indexes

- The client extracts the text and sends JSON `{ filename, text }`; the server never receives or parses a file. Use `file.text()` for a `.txt` file, pdf.js for a PDF and mammoth for a DOCX, in the browser. `chunkSize` and `embeddingModel` are optional in the upload, and a missing one comes from the default profile.
- A document belongs to one user. Another user's document is a 404 "Document not found" for everyone, admins included; so is an id that is not a UUID.
- `POST /v1/documents` stores the document and queues its first index, and answers 202: the index is built in the background. **Poll the index every 2 to 3 seconds** (`GET /v1/documents/:id/indexes/:indexId`, or `GET /v1/documents/:id`, which has the indexes) until its `status` is `ready` or `failed`. Stop polling when the user leaves the screen.
- Index `status`: `queued` (in the line; `queuePosition` is its place, 1 being next), `indexing` (`embeddedCount` of `chunkCount` is the progress), `ready`, `failed` (`error` says why). An index can go back from `indexing` to `queued` while the model server is away or between tries; it keeps the vectors it has. After a failure `POST /v1/documents/:id/indexes` queues it again.
- `POST /v1/documents/:id/indexes` makes sure an index exists at a chunk size and model (both optional, default profile). A new one, or a failed one, answers 202 and counts as a build; one that is already queued, being built or ready answers 200 and nothing is built. There are no other ways to start a build: `POST /v1/configuration/resolve` stays a dry run.
- To cancel a build, delete the index (`DELETE /v1/documents/:id/indexes/:indexId`) or the document. There is no `cancelled` status. The build still counts in the daily limits.
- Limits, from `GET /v1/configuration` (`documents` and `indexes`): documents per user (409 over it; nothing is deleted automatically), builds in progress per user (409), builds in the last 24 hours per user and for all users together (429 both, no `Retry-After` helps: say so to the user), and a full queue (503, try again in a few minutes). Uploads, and the build route, are limited to 5 per user per minute each (429 with `Retry-After`). Deleting does not give a build back.
- The text is stored cleaned: Unicode NFC, `\n` line breaks, control characters removed. Its length limit (`documents.maxCharacters`, in UTF-16 units, so an emoji counts as 2) is checked on the text as sent and again after cleaning. The same text twice by one user is a 409. A body is read up to 3 bytes per allowed character plus 16 kB; more is a 413.
- A filename is a label, trimmed and normalized. Render it, like any text a user wrote, as text and never as HTML.

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
| `GET /v1/configuration` | Token | `200` `{ success, message: "Configuration retrieved successfully", data: { version, defaults, settings, profiles, documents, indexes } }` |
| `POST /v1/configuration/resolve` | Token | Optional body `{ profileId?, overrides? }`. `200` `{ success, message: "Configuration resolved successfully", data: { profileId, snapshot, hash } }`; `400` "Validation error" or "The configuration is not valid" (with `details`); `404` "Profile not found"; `413`; `500` for a profile at another configuration version or a default profile that is not valid |
| `GET /v1/profiles` | Token | `200` `{ success, message: "Profiles retrieved successfully", data: Profile[] }`, oldest first |
| `POST /v1/profiles` | Token | Body `{ name, settings? }`. `201` `{ success, message: "Profile created successfully", data: Profile }`; `400`; `409` "A profile with that name already exists" or "You have reached the maximum number of profiles"; `413` |
| `GET /v1/profiles/:id` | Token | `200` `{ success, message: "Profile retrieved successfully", data: Profile }`; `404` "Profile not found" |
| `PATCH /v1/profiles/:id` | Token | Body with `name` and/or `settings`, at least one. `200` `{ success, message: "Profile updated successfully", data: Profile }`; `400`; `404`; `409` "A profile with that name already exists" or "This profile was saved by another configuration version"; `413` |
| `DELETE /v1/profiles/:id` | Token | `200` `{ success, message: "Profile deleted successfully" }` (no `data`); `404` |
| `GET /v1/documents` | Token | `200` `{ success, message: "Documents retrieved successfully", data: Document[] }`, newest first, each with its indexes |
| `POST /v1/documents` | Token | Body `{ filename, text, chunkSize?, embeddingModel? }`. `202` `{ success, message: "Document accepted for indexing", data: Document }`; `400` validation or "The document has no readable text"; `409` "You have reached the maximum number of documents", "You already have a document with this text" or "You have reached the maximum number of index builds in progress; try again when one finishes"; `413`; `429` over 5 requests per minute, or the daily limit of builds of the user ("You have reached the daily limit of index builds, please try again later") or of all users ("The daily indexing capacity is used up, please try again tomorrow"); `503` "The indexing queue is full, please try again in a few minutes" |
| `GET /v1/documents/:id` | Token | `200` `{ success, message: "Document retrieved successfully", data: Document }`; `404` "Document not found" |
| `DELETE /v1/documents/:id` | Token | `200` `{ success, message: "Document deleted successfully" }` (no `data`); `404`. Aborts a build in progress |
| `POST /v1/documents/:id/indexes` | Token | Optional body `{ chunkSize?, embeddingModel? }`. `202` `{ success, message: "Index queued for building", data: DocumentIndex }` for a new or a failed index; `200` "Index already exists" when it is queued, being built or ready; `400`; `404` "Document not found"; `409` builds in progress, or "The index changed while it was being queued, please try again"; `413`; `429` as for an upload; `503` queue full |
| `GET /v1/documents/:id/indexes/:indexId` | Token | `200` `{ success, message: "Index retrieved successfully", data: DocumentIndex }`; `404` "Document not found" or "Index not found" |
| `DELETE /v1/documents/:id/indexes/:indexId` | Token | `200` `{ success, message: "Index deleted successfully" }` (no `data`); `404`. Aborts the build when it is in progress |

`Document` is `{ id, filename, characterCount, contentHash, createdAt, indexes }`; the text and the owner's id are never returned. `DocumentIndex` is `{ id, documentId, chunkSize, embeddingModel, status, chunkCount, embeddedCount, embeddingTokens, attempts, error, queuePosition, createdAt, queuedAt, startedAt, finishedAt }`; `status` is `queued`, `indexing`, `ready` or `failed`, `error` and `queuePosition` are `null` when they do not apply, and `embeddingTokens` is a total for the index.

`Profile` is `{ id, name, settings, problems, createdAt, updatedAt }`; the owner's id and the configuration version are never returned. `data` of the configuration view holds `version`, `defaults` (the eleven settings as the database has them), `settings` (the definitions), `profiles` (`maxPerUser`, `maxNameLength`), `documents` (`maxPerUser`, `maxCharacters`, `maxFilenameLength`) and `indexes` (`maxActivePerUser`, `maxBuildsPerDay`, `maxBuildsPerDayTotal`).

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
