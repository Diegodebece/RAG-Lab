import Joi from "joi";
import { PROFILE_NAME_MAX_LENGTH } from "../config/configuration.config.js";
import { settingsSchema } from "./configuration.validator.js";
import type { SettingsInput } from "./configuration.validator.js";

export interface CreateProfileInput {
    name: string;
    settings?: SettingsInput;
}

export interface UpdateProfileInput {
    name?: string;
    settings?: SettingsInput;
}

// Control characters (Cc), format characters such as the zero-width and the direction marks (Cf), lone surrogates (Cs)
// and the line and paragraph separators (Zl, Zp): they make two names look alike, or hide in a name.
const INVISIBLE_CHARACTER = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;

// The name is stored in Unicode form NFC and trimmed, so two spellings of the same text are one name. Joi counts UTF-16
// code units, so a name with characters outside the basic plane (an emoji) may be refused a little before the table's
// limit of 100 characters; it is never accepted past it.
const nameRule = Joi.string().normalize("NFC").trim().max(PROFILE_NAME_MAX_LENGTH).pattern(INVISIBLE_CHARACTER, { invert: true }).messages({
    "string.base": "Name must be a string",
    "string.empty": "Name cannot be empty",
    "string.max": "Name cannot have more than {#limit} characters",
    "string.pattern.invert.base": "Name cannot contain control or invisible characters",
    "any.required": "Name is required"
});

// A profile holds a name and only the settings the user set: the rest comes from the default profile. The owner, the id,
// the version and the dates are never the client's to send.
export const createProfileSchema = Joi.object<CreateProfileInput>({
    name: nameRule.required(),
    settings: settingsSchema
});

// The settings sent replace the stored ones as a whole.
export const updateProfileSchema = Joi.object<UpdateProfileInput>({
    name: nameRule,
    settings: settingsSchema
}).min(1).messages({
    "object.min": "At least one field must be provided"
});
