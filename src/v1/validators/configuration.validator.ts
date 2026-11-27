import Joi from "joi";
import { SETTING_CAPS, SETTING_KEYS } from "../config/configuration.config.js";
import type { ConfigurationSettings, SettingKey } from "../types/configuration.type.js";

// settings a user chose: any of the eleven, none required
export type SettingsInput = Partial<ConfigurationSettings>;

export interface ResolveConfigurationInput {
    profileId?: string;
    overrides?: SettingsInput;
}

// One definition of each setting's rule, built from its cap, so the caps are written once (configuration.config.ts) and
// every schema agrees with them. Nothing is converted (a number written as text is refused, 0.305 is refused and not
// rounded to 0.31), and every message names the setting by its label and never repeats the value it was given.
const ruleFor = (key: SettingKey) => {
    const cap = SETTING_CAPS[key];
    const label = cap.label;

    // Joi.any().valid(...): whatever is not exactly one of the values, of any type, is one "any.only" error
    if ("allowed" in cap) {
        return Joi.any().valid(...cap.allowed).strict().messages({
            "any.only": `${label} must be one of ${cap.allowed.join(", ")}`
        });
    }

    let rule = Joi.number().strict().min(cap.min).max(cap.max);

    if (cap.type === "integer") {
        rule = rule.integer();
    }

    if ("decimals" in cap) {
        rule = rule.precision(cap.decimals);
    }

    return rule.messages({
        "number.base": `${label} must be a number`,
        "number.integer": `${label} must be a whole number`,
        "number.min": `${label} must be at least {#limit}`,
        "number.max": `${label} must be at most {#limit}`,
        "number.precision": `${label} must have at most {#limit} decimal places`,
        "number.infinity": `${label} is out of range`,
        "number.unsafe": `${label} is out of range`
    });
};

// Joi copies an object before it validates it, and the copy cannot hold an own key called "__proto__": it is dropped
// without a trace, so the schema would accept it. This object type looks at the object as it arrived, before Joi copies
// it, and refuses that key like any other key that is not a setting. It also refuses a value that is not an object
// here, so the text of an object ("{}") is never parsed into one (Joi's object type does that when it converts).
const SettingsJoi = Joi.extend((joi) => ({
    type: "object",
    base: joi.object(),
    prepare(value: unknown, helpers: Joi.CustomHelpers) {
        if (value === undefined) {
            return undefined;
        }

        if (typeof value !== "object" || value === null || Array.isArray(value)) {
            return { value, errors: helpers.error("object.base") };
        }

        if (Object.hasOwn(value, "__proto__")) {
            const state = helpers.state.localize([...helpers.state.path, "__proto__"], []);
            return { value, errors: helpers.error("object.unknown", { child: "__proto__" }, state) };
        }

        return undefined;
    }
}));

const objectMessages = {
    "object.base": "Settings must be an object",
    "object.unknown": "Unknown setting: {#child}"
};

// the settings a user may give: each one optional; a key that is not a setting of this version is refused, one detail
// each (including __proto__, constructor and prototype). convert is on for the object itself, so the check above runs;
// the rules of each setting turn it off for their own value, so nothing else is converted.
export const settingsSchema = SettingsJoi.object<SettingsInput>(
    Object.fromEntries(SETTING_KEYS.map((key) => [key, ruleFor(key)]))
).prefs({ convert: true }).messages(objectMessages);

// the settings of a resolved configuration: all eleven
export const completeSettingsSchema = SettingsJoi.object<ConfigurationSettings>(
    Object.fromEntries(SETTING_KEYS.map((key) => [key, ruleFor(key).required().messages({ "any.required": `${SETTING_CAPS[key].label} is required` })]))
).prefs({ convert: true }).messages(objectMessages);

const profileIdRule = Joi.string().guid({ version: "uuidv4" }).messages({
    "string.base": "Profile id must be a valid UUID",
    "string.empty": "Profile id must be a valid UUID",
    "string.guid": "Profile id must be a valid UUID"
});

// the body of POST /v1/configuration/resolve: which profile to start from, and settings that win over it
export const resolveConfigurationSchema = Joi.object<ResolveConfigurationInput>({
    profileId: profileIdRule,
    overrides: settingsSchema
});
