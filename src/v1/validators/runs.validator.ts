import Joi from "joi";
import { RETRIEVAL_SETTING_KEYS, SETTING_CAPS, SETTING_KEYS } from "../config/configuration.config.js";
import { QUESTION_MAX_CHARACTERS } from "../config/limits.config.js";
import type { RetrievalSettings } from "../types/runs.type.js";
import { profileIdRule, settingsSchema } from "./configuration.validator.js";

// The body of a search: the question, the profile to start from and the settings that win over it. A search runs with the six
// retrieval settings; the five answer settings do not apply to it, and a search never accepts a setting and ignores it, so they are
// refused with a message of their own (even with a valid value). Nothing a run stores or hashes (a snapshot, a hash, a
// configuration) comes from the client: those are unknown fields, which Joi refuses.
export interface SearchDocumentInput {
    question: string;
    profileId?: string;
    overrides?: Partial<RetrievalSettings>;
}

// the settings that are not retrieval ones, in the order the API lists them
const ANSWER_SETTING_KEYS = SETTING_KEYS.filter((key) => !(RETRIEVAL_SETTING_KEYS as readonly string[]).includes(key));

// the settings schema with each answer setting forbidden: a key that is given, whatever its value, is "<Label> does not apply to a search"
const searchOverridesSchema = ANSWER_SETTING_KEYS.reduce(
    (schema, key) => schema.fork(key, (rule) => rule.forbidden().messages({ "any.unknown": `${SETTING_CAPS[key].label} does not apply to a search` })),
    settingsSchema
);

export const searchDocumentSchema = Joi.object<SearchDocumentInput>({
    // the question rule of RAG Web, with its messages: trimmed before it is counted, so the limit is on the text that is embedded
    question: Joi.string().trim().min(1).max(QUESTION_MAX_CHARACTERS).required().messages({
        "string.base": "Question must be a string",
        "string.empty": "Question cannot be empty",
        "string.max": "Question cannot have more than {#limit} characters",
        "any.required": "Question is required"
    }),
    profileId: profileIdRule,
    overrides: searchOverridesSchema
});
