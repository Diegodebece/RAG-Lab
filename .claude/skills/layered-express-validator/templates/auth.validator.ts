import Joi from "joi";
import { MAX_EMAIL_LENGTH, MAX_PASSWORD_LENGTH } from "../config/auth.config.js";

export interface LoginUserInput {
    email: string;
    password: string;
}

// Normalized to NFC, trimmed and lowercased, so an address is stored and compared one way only:
// "josé" typed as one character or as "e" plus a combining accent is the same account. The length is checked
// after trimming (Joi converts before it validates), and before the address is parsed, so a huge value is refused
// without being worked on. One message per email: a value that is too long is also not a valid address, and the
// client should hear about it once. Shared with the schemas that create an account.
export const emailRule = Joi.string().normalize("NFC").trim().lowercase().max(MAX_EMAIL_LENGTH).email().required().prefs({ abortEarly: true }).messages({
    "string.base": "Email must be a string",
    "string.empty": "Email cannot be empty",
    "string.email": "Email must be a valid email address",
    "string.max": "Email cannot have more than {#limit} characters",
    "any.required": "Email is required"
});

// No minimum here: login only checks the password, it does not enforce the policy again. Passwords are not
// trimmed: spaces are valid characters.
export const loginUserSchema = Joi.object<LoginUserInput>({
    email: emailRule,
    password: Joi.string().max(MAX_PASSWORD_LENGTH).required().messages({
        "string.base": "Password must be a string",
        "string.empty": "Password cannot be empty",
        "string.max": "Password cannot have more than {#limit} characters",
        "any.required": "Password is required"
    })
});

// For the schemas of an admin who creates accounts, a password change and a role or status change, see
// users.validator.ts in RAG Lab: a new password has MIN_PASSWORD_LENGTH to MAX_PASSWORD_LENGTH characters (not
// trimmed); the current password has no minimum; roles and statuses use Joi.any().valid(...) with one "any.only"
// message; a PATCH takes .min(1) and only the fields an admin may change.
