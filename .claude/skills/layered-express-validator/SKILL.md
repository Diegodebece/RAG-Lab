---
name: layered-express-validator
description: How to write Joi request-body schemas for an Express API. Use when creating or editing any v1/validators/*.validator.ts file or adding validation to a POST/PATCH endpoint.
---

# Joi validators

## 1. Location & naming

- File: `v1/validators/<entities>.validator.ts` (e.g. `products.validator.ts`).
- Schemas: `create<Entity>Schema`, `update<Entity>Schema`; custom actions `<verb><Entity>Schema` (e.g. `loginUserSchema`, `changeUserRoleSchema`).
- Input types, in the same file: `Create<Entity>Input`, `Update<Entity>Input`; custom actions `<Verb><Entity>Input` (e.g. `LoginUserInput`).

## 2. Responsibilities

- Does: shape, type, format and range checks on the request body.
- Never: database lookups, uniqueness checks or business rules (those belong in the service).

## 3. Template

[templates/products.validator.ts](templates/products.validator.ts)

[templates/auth.validator.ts](templates/auth.validator.ts) — the shared `emailRule` and the login schema; needs the length constants of `config/auth.config.ts` (see `layered-express-middleware`)

## 4. Rules

- Every POST/PATCH endpoint with a body has a schema, used through `validateBodyMiddleware`.
- Every schema has a matching exported input type describing the validated output (after `.trim()` etc.):
  - `export interface Create<Entity>Input { ... }` — fields without `.required()` are optional (`description?: string`); enums are string-literal unions (`status?: "active" | "inactive"`).
  - `export type Update<Entity>Input = Partial<Create<Entity>Input>;`
  - Pass the type to Joi so keys are checked against it: `Joi.object<Create<Entity>Input>({ ... })`.
  - Keep the interface and the schema in sync: adding, removing or renaming a field changes both.
- `update<Entity>Schema` is derived from the create schema with `.fork([...requiredFields], (field) => field.optional())` plus `.min(1)`, so a PATCH needs at least one field and never requires everything.
- Every rule has a custom English message in `.messages({...})`. Use `{#limit}` instead of hardcoding numbers.
- Strings: `.trim()` on user-typed text; `.email()` for emails; `.uri()` for URLs.
- Emails use the one shared `emailRule` (`auth.validator.ts`): `.normalize("NFC").trim().lowercase().max(MAX_EMAIL_LENGTH).email()`, with one message per failure, so an address is stored and compared one way, the length is checked before the address is parsed, and every schema, script and rate-limit key that takes an email agrees. Other code that takes an email (a script, `create-admin`) validates it with the same rule, not its own.
- Passwords are never trimmed (spaces are valid characters). Lengths come from `MIN_PASSWORD_LENGTH` and `MAX_PASSWORD_LENGTH` in `config/auth.config.ts`, not from numbers in the schema: a new password has both, the password typed at login and the current password of a change have only the maximum, so an account made under an older rule can still log in and change it.
- A role or status field uses `Joi.any().valid("a", "b")` with one `"any.only"` message: an empty string, `null`, a number or a list is then one error, where `Joi.string()` would add a second one for the empty string.
- Enums: `.valid("a", "b")` with an `"any.only"` message listing the options.
- Do **not** use `.default()`: defaults belong to the database/service, and a default in a create schema leaks into the derived update schema.
- Never accept privileged fields from public endpoints (e.g. `role`, `plan`, `id`, `userId` in a register schema). Unknown keys are rejected by Joi by default; keep it that way. An admin-only endpoint may take them (RAG Lab: an admin chooses the `role` of the account they create, never its `status`).
- Ids are UUIDs: `Joi.string().guid({ version: "uuidv4" })` with a `"string.guid"` message; the input type declares them as `string`.

## 5. Checklist

- [ ] Both `create<Entity>Schema` and `update<Entity>Schema` exported.
- [ ] Matching `Create<Entity>Input` / `Update<Entity>Input` types exported and in sync with the schemas.
- [ ] Every rule has an English message.
- [ ] No `.default()`, no privileged fields on public schemas.
- [ ] No DB or business checks.
