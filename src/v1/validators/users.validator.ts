import Joi from "joi";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "../config/auth.config.js";
import type { UserRole, UserStatus } from "../types/users.type.js";
import { emailRule } from "./auth.validator.js";

export interface CreateUserInput {
    email: string;
    password: string;
    role?: UserRole;
}

export interface UpdateUserInput {
    role?: UserRole;
    status?: UserStatus;
}

export interface ChangePasswordInput {
    currentPassword: string;
    newPassword: string;
}

// Passwords are not trimmed: spaces are valid characters and count towards the length.
const newPasswordRule = Joi.string().min(MIN_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH).required().messages({
    "string.base": "Password must be a string",
    "string.empty": "Password cannot be empty",
    "string.min": "Password must have at least {#limit} characters",
    "string.max": "Password cannot have more than {#limit} characters",
    "any.required": "Password is required"
});

// Joi.any().valid(...): whatever is not exactly one of the values (an empty string, null, a number, a list) is one
// "any.only" error, where Joi.string() would add a second one for the empty string.
const roleRule = Joi.any().valid("user", "admin").messages({
    "any.only": "Role must be 'user' or 'admin'"
});

const statusRule = Joi.any().valid("active", "disabled").messages({
    "any.only": "Status must be 'active' or 'disabled'"
});

// An admin creates the accounts, so the role is theirs to choose (an account is a user unless they say otherwise).
// The status is not: a new account is active.
export const createUserSchema = Joi.object<CreateUserInput>({
    email: emailRule,
    password: newPasswordRule,
    role: roleRule
});

// An admin changes the role and the status, nothing else: not the email, not the password.
export const updateUserSchema = Joi.object<UpdateUserInput>({
    role: roleRule,
    status: statusRule
}).min(1).messages({
    "object.min": "At least one field must be provided"
});

// The current password has no minimum: an account made before a rule changed may have a password the rule would
// not allow today, and it must still be able to type it to change it.
export const changePasswordSchema = Joi.object<ChangePasswordInput>({
    currentPassword: Joi.string().max(MAX_PASSWORD_LENGTH).required().messages({
        "string.base": "Current password must be a string",
        "string.empty": "Current password cannot be empty",
        "string.max": "Current password cannot have more than {#limit} characters",
        "any.required": "Current password is required"
    }),
    newPassword: Joi.string().min(MIN_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH).required().messages({
        "string.base": "New password must be a string",
        "string.empty": "New password cannot be empty",
        "string.min": "New password must have at least {#limit} characters",
        "string.max": "New password cannot have more than {#limit} characters",
        "any.required": "New password is required"
    })
});
