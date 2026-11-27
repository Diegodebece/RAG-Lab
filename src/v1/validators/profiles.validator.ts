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
// and the line and paragraph separators (Zl, Zp): they make two names look alike, or hide in a name. Also the characters
// that draw nothing but are none of those: the Hangul fillers (U+3164, U+115F, U+1160, U+FFA0), the combining grapheme
// joiner (U+034F) and the braille blank (U+2800). The zero-width joiner is a format character, so a joined emoji
// sequence is refused too (the cost of refusing all of them); a variation selector after an emoji is a mark, and stays.
const INVISIBLE_CHARACTER = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\u3164\u115F\u1160\uFFA0\u034F\u2800]/u;

// Every space of category Zs (the no-break space, the em space, the ideographic space...) inside a name is a plain
// space once stored, so "a b" with another kind of space is the same name as "a b".
const SPACE_SEPARATOR = /\p{Zs}/gu;

// A name needs something to read: a letter, a number, a symbol or punctuation. A name of marks alone would show as nothing.
const READABLE_CHARACTER = /[\p{L}\p{N}\p{S}\p{P}]/u;

// The name is stored in Unicode form NFC, with its spaces made plain and trimmed (JavaScript's trim removes every Zs
// space at the ends, so the order of the replacement and the trim does not change the result), so two spellings of the
// same text are one name. Joi counts UTF-16 code units, so a name with characters outside the basic plane (an emoji)
// may be refused a little before the table's limit of 100 characters; it is never accepted past it.
const nameRule = Joi.string().normalize("NFC").replace(SPACE_SEPARATOR, " ").trim().max(PROFILE_NAME_MAX_LENGTH)
    .pattern(INVISIBLE_CHARACTER, { invert: true })
    .pattern(READABLE_CHARACTER, "readable")
    .messages({
        "string.base": "Name must be a string",
        "string.empty": "Name cannot be empty",
        "string.max": "Name cannot have more than {#limit} characters",
        "string.pattern.invert.base": "Name cannot contain control or invisible characters",
        "string.pattern.name": "Name must contain a letter, number, symbol or punctuation",
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
