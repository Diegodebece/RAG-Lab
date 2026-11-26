# API contract

The contract the frontend is built from, as OpenAPI 3.1: [openapi.yaml](openapi.yaml). It is the docs-keeper's job to keep it equal to the validators and controllers: every route, its request and response shapes, status codes and errors. Until the contract is frozen (layer 11 of the [build order](../design.md#13-build-order)), a layer may change what it added before.

## Conventions

- Every path starts with `/v1`. Requests and responses are JSON.
- Success: `{ success: true, message, data }`.
- Error: `{ message }`, plus `details` (a list of strings) for validation errors. Only the error middleware writes error responses, so every error has this shape, a 404 and a 429 included.
- Protected paths need `Authorization: Bearer <token>`. The scheme name is case-insensitive; anything after the token makes the header invalid.
- Every response carries `Cache-Control: no-store` and the other security headers of `securityHeaders.middleware.ts`.
- Limits answer 429 with `RateLimit` and `RateLimit-Policy` headers (IETF draft 8 form) and `Retry-After`.

## Endpoints today

| Method and path | Access | Answers |
|---|---|---|
| `GET /v1/health` | Public | `200` `{ success: true, message: "Health check completed", data: { status, database, ollama } }`; `429` over 30 checks per minute per address |

`status` is `ok`, `degraded` (Ollama down or a required model missing) or `down` (database down); `database` and `ollama` are `up` or `down`. The endpoint answers `200` in all three cases: only a request that gets no answer at all means the API is offline. A model name or an error is never part of the response.

## Every other path under `/v1`

| Situation | Status | `message` |
|---|---|---|
| No `Authorization` header, or not `Bearer <token>` | 401 | Authentication token is missing |
| Forged, expired or otherwise invalid token | 401 | Invalid or expired authentication token |
| Valid token, path does not exist | 404 | Route not found |
| Valid token, over the per-user limit (120 per minute by default) | 429 | Too many requests, please try again later |

The token is checked before the path, so an unknown path without a token is a 401. A path outside `/v1` is a 404 without a token. An unexpected failure is a 500 with `{ message: "Internal server error" }`.
