import Joi from "joi";
import { SETTING_CAPS, SETTING_KEYS } from "../config/configuration.config.js";
import type { ConfigurationSettings, SettingKey } from "../types/configuration.type.js";
import { unknownSettingMessage } from "../utils/unknownSetting.util.js";
import { UUID_PATTERN } from "../utils/uuid.util.js";

// settings a user chose: any of the eleven, none required
export type SettingsInput = Partial<ConfigurationSettings>;

export interface ResolveConfigurationInput {
    profileId?: string;
    overrides?: SettingsInput;
}

// One definition of each setting's rule, built from its cap, so the caps are written once (configuration.config.ts) and
// every schema agrees with them. Nothing is converted: a number written as text is refused, and 0.305 is refused and not
// rounded to 0.31. A value is never rounded or clamped by the API (it is refused instead); JSON numbers beyond double
// precision are already rounded by JSON.parse before they get here, which no schema can see. Every message names the
// setting by its label and never repeats the value it was given; only an unknown key is repeated, cut to 64 characters.
export const settingRuleFor = (key: SettingKey) => {
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
// it, and gives that key another name (a stand-in that is not a setting), so Joi refuses it like any other unknown key
// and still validates the rest of the object: the problems of one object are all reported, none hides another. The
// error function below puts the real name back. It also refuses a value that is not an object here, so the text of an
// object ("{}") is never parsed into one (Joi's object type does that when it converts).
const PROTO_KEY = "__proto__";
const PROTO_KEY_STAND_IN = "\u0000renamed-__proto__";

const SettingsJoi: Joi.Root = Joi.extend((joi: Joi.Root) => ({
    type: "object",
    base: joi.object(),
    prepare(value: unknown, helpers: Joi.CustomHelpers) {
        if (value === undefined) {
            return undefined;
        }

        if (typeof value !== "object" || value === null || Array.isArray(value)) {
            return { value, errors: helpers.error("object.base") };
        }

        if (Object.hasOwn(value, PROTO_KEY)) {
            // fromEntries defines each key as an own property, so the stand-in is a key like any other
            const renamed: Record<string, unknown> = Object.fromEntries(
                Object.entries(value).map(([key, item]) => [key === PROTO_KEY ? PROTO_KEY_STAND_IN : key, item])
            );
            return { value: renamed };
        }

        return undefined;
    }
}));

// the one message of an unknown key, with the key cut to 64 characters and the real name of the renamed __proto__
const describeUnknownKeys: Joi.ValidationErrorFunction = (errors) => {
    for (const report of errors) {
        if (report.code !== "object.unknown") {
            continue;
        }

        const child: unknown = report.local.child;

        if (typeof child === "string") {
            const key = child === PROTO_KEY_STAND_IN ? PROTO_KEY : child;
            report.path = [...report.path.slice(0, -1), key];
            report.message = unknownSettingMessage(key);
        }
    }

    return errors;
};

const objectMessages = {
    "object.base": "Settings must be an object"
};

// the settings a user may give: each one optional; a key that is not a setting of this version is refused, one detail
// each (including __proto__, constructor and prototype). convert is on for the object itself, so the check above runs;
// the rules of each setting turn it off for their own value, so nothing else is converted.
export const settingsSchema = SettingsJoi.object<SettingsInput>(
    Object.fromEntries(SETTING_KEYS.map((key) => [key, settingRuleFor(key)]))
).prefs({ convert: true }).messages(objectMessages).error(describeUnknownKeys);

// the settings of a resolved configuration: all eleven
export const completeSettingsSchema = SettingsJoi.object<ConfigurationSettings>(
    Object.fromEntries(SETTING_KEYS.map((key) => [key, settingRuleFor(key).required().messages({ "any.required": `${SETTING_CAPS[key].label} is required` })]))
).prefs({ convert: true }).messages(objectMessages).error(describeUnknownKeys);

// the plain hyphenated UUID of any version and case: the rule of isUuid, so the id is never valid to this schema and
// unknown to the lookup that follows
const profileIdRule = Joi.string().pattern(UUID_PATTERN).messages({
    "string.base": "Profile id must be a valid UUID",
    "string.empty": "Profile id must be a valid UUID",
    "string.pattern.base": "Profile id must be a valid UUID"
});

// the body of POST /v1/configuration/resolve: which profile to start from, and settings that win over it
export const resolveConfigurationSchema = Joi.object<ResolveConfigurationInput>({
    profileId: profileIdRule,
    overrides: settingsSchema
});
