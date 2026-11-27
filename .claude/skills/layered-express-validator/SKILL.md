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

[templates/configuration.validator.ts](templates/configuration.validator.ts) — strict schemas for user settings, built from the caps; needs `config/configuration.config.ts` and `types/configuration.type.ts` (see `layered-express-structure`) and the two utils of `layered-express-service`

[templates/documents.validator.ts](templates/documents.validator.ts) — an upload body (`{ filename, text }`) plus index-time fields built from the caps with `settingRuleFor`, which `configuration.validator.ts` exports; the ported filename rule

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
- Ids are UUIDs: `Joi.string().guid({ version: "uuidv4" })` with a `"string.guid"` message; the input type declares them as `string`. An id that a service then looks up with `isUuid` uses `Joi.string().pattern(UUID_PATTERN)` instead (`utils/uuid.util.ts`), so the schema and the lookup accept the same ids (any version, hyphenated only) and an id is never valid to one and unknown to the other.

### Settings chosen by users

- One rule per setting, built from its cap in `config/` (`ruleFor(key)` in the template), so the caps are written once and every schema agrees. A setting with a list of allowed values uses `Joi.any().valid(...).strict()`; a number uses `Joi.number().strict().min().max()`, with `.integer()` when it is a whole number.
- Nothing is converted. `.strict()` on each rule refuses a number written as text (`"3"`), and no rule rounds, clamps or defaults. `.precision(n)` is used for the most decimal places, and it only refuses: with `convert` on it would round, so the rule turns `convert` off for its own value (`.strict()`), and a value with too many decimals is a 400 (0.305, or the 0.30000000000000004 that a client's own arithmetic gives). Documents say so, and tell clients to round before sending.
- Settings objects refuse unknown keys (the Joi default; keep it) and the message repeats only the key, never the value. Echo a key cut to a fixed length (64 code points plus an ellipsis, `unknownSettingMessage`), because a body may carry a key of thousands of characters. A top-level unknown field of a body is still echoed whole by Joi's own message.
- Joi copies an object before it validates it, and the copy drops an own `__proto__` key without a trace, so a schema would accept it. Extend Joi with an object type whose `prepare` hook looks at the object as it arrived and renames that key to a stand-in that is not a setting; the schema then refuses it like any unknown key, the rest of the object is still validated (every problem is reported, none hides another), and the error function puts the real name back. The same hook refuses a value that is not an object, so the text `"{}"` is never parsed into one. A test sends the body as raw text, because only `JSON.parse` of the text creates the key.
- A name that users type and that must be unique (a profile name) goes through one rule: Unicode NFC, every space of category `Zs` turned into a plain space, trimmed, a maximum length, no control, format, surrogate, line or paragraph separator characters (`\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}`) and none of the characters that draw nothing without being those (U+3164, U+115F, U+1160, U+FFA0, U+034F, U+2800), and at least one letter, number, symbol or punctuation (`[\p{L}\p{N}\p{S}\p{P}]`), so a name of marks alone is refused. The zero-width joiner is a format character, so joined emoji sequences are refused; that is a known cost. Joi counts UTF-16 units, so a name of emoji can be refused a little before the database's limit, never accepted past it.
### Uploads and index-time fields

- A schema that accepts a user setting reuses the one rule of that setting: `chunkSize: settingRuleFor("chunkSize")`, exported by `configuration.validator.ts` and built from the caps. Never write the allowed values again in another schema; the caps are written once. The fields are optional and nothing is defaulted in the schema: a missing value is the default profile's, filled in by the service through the resolver. A body for an existing document's index has only those two fields; one for a new document has `filename` and `text` besides them, and no owner, status, hash or question-time setting.
- A text sent by the client is not cleaned by Joi: the schema only checks that it is a string and its maximum length in UTF-16 units (the unit the database's character count uses, and `MAX_DOCUMENT_CHARACTERS`), counted before cleaning. The service cleans it (`sanitizeText`) before it is hashed, chunked and stored, because the hash and the chunks must come from the stored text.
- The filename is trimmed and normalized (NFC), has 1 to `FILENAME_MAX_LENGTH` characters (the number the table checks too) and refuses control characters and the marks that reverse the direction of text (U+061C, U+200E, U+200F, U+202A to U+202E, U+2066 to U+2069), which can make `invoice[U+202E]txt.exe` display as `invoiceexe.txt`. The ranges are written as numbers, so the file holds no invisible character. A filename is only a label: it is never used as a path.

## 5. Checklist

- [ ] Both `create<Entity>Schema` and `update<Entity>Schema` exported.
- [ ] Matching `Create<Entity>Input` / `Update<Entity>Input` types exported and in sync with the schemas.
- [ ] Every rule has an English message.
- [ ] No `.default()`, no privileged fields on public schemas.
- [ ] No DB or business checks.
