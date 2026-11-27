import type { Pool } from "pg";
import { pool } from "../config/db.config.js";
import { CONFIGURATION_VERSION, PROFILE_NAME_MAX_LENGTH, SETTING_CAPS, SETTING_KEYS } from "../config/configuration.config.js";
import { MAX_PROFILES_PER_USER } from "../config/limits.config.js";
import type { ConfigurationSettings, ConfigurationView, ResolvedConfiguration, SettingDefinition } from "../types/configuration.type.js";
import { AppError } from "../utils/appError.util.js";
import { freezeSnapshot, hashSnapshotText, toCanonicalJson } from "../utils/configurationSnapshot.util.js";
import { isUuid } from "../utils/uuid.util.js";
import { completeSettingsSchema } from "../validators/configuration.validator.js";
import type { ResolveConfigurationInput } from "../validators/configuration.validator.js";

interface DefaultProfileRow {
    version: number;
    settings: Record<string, unknown>;
}

const isSettingKey = (key: string): boolean => (SETTING_KEYS as readonly string[]).includes(key);

// "Unknown setting: <key>" for each key of a stored or given object that is not a setting of this version
const unknownKeyProblems = (settings: object): string[] =>
    Object.keys(settings).filter((key) => !isSettingKey(key)).map((key) => `Unknown setting: ${key}`);

// the one row of default_profile; a database without it is not one this code can run on, so it is a plain Error (500),
// and the server does not start on it (getConfigurationProblemsService)
const readDefaultProfile = async (targetPool: Pool): Promise<DefaultProfileRow> => {
    const { rows } = await targetPool.query<DefaultProfileRow>("SELECT version, settings FROM default_profile");

    if (rows.length === 0) {
        throw new Error("The default profile is missing from the default_profile table");
    }

    return rows[0];
};

// What each setting accepts, for a client that builds a form: the definition of every setting in order, the defaults the
// database holds right now, and the limits on profiles.
export const getConfigurationService = async (): Promise<ConfigurationView> => {
    const defaults = await readDefaultProfile(pool);

    const settings = SETTING_KEYS.map((key): SettingDefinition => {
        const { label, kind, type, ...caps } = SETTING_CAPS[key];
        return { key, label, kind, type, ...caps };
    });

    return {
        version: CONFIGURATION_VERSION,
        defaults: defaults.settings,
        settings,
        profiles: { maxPerUser: MAX_PROFILES_PER_USER, maxNameLength: PROFILE_NAME_MAX_LENGTH }
    };
};

// Turns what a user chose into the complete configuration a question will use: for each setting, the override if there
// is one, else the stored profile's value, else the default's. It reads the database and checks the result; it calls no
// model and holds no transaction. A key is looked up as an own property, never read through the prototype and never
// copied from one object into another, so a key like "__proto__" is not a way to reach the result.
// A profile of another user is the same 404 as one that does not exist. Anything outside the caps, in a profile stored
// before a cap changed or in the default itself, is a 400 with every problem listed: nothing is clamped, so the
// snapshot always matches what ran.
export const resolveConfigurationService = async (userId: string, input: ResolveConfigurationInput = {}): Promise<ResolvedConfiguration> => {
    const { profileId, overrides } = input;
    let stored: Record<string, unknown> = {};

    if (profileId !== undefined) {
        if (!isUuid(profileId)) {
            throw new AppError(404, "Profile not found");
        }

        const { rows } = await pool.query<{ settings: Record<string, unknown> }>(
            "SELECT settings FROM profiles WHERE id = $1 AND user_id = $2",
            [profileId, userId]
        );

        if (rows.length === 0) {
            throw new AppError(404, "Profile not found");
        }

        stored = rows[0].settings;
    }

    const defaults = (await readDefaultProfile(pool)).settings;
    const chosen: Record<string, unknown> = overrides ?? {};
    const merged: Record<string, unknown> = {};

    for (const key of SETTING_KEYS) {
        if (Object.hasOwn(chosen, key)) {
            merged[key] = chosen[key];
        } else if (Object.hasOwn(stored, key)) {
            merged[key] = stored[key];
        } else if (Object.hasOwn(defaults, key)) {
            merged[key] = defaults[key];
        }
    }

    const { error, value } = completeSettingsSchema.validate(merged, { abortEarly: false });
    const problems = [...unknownKeyProblems(stored), ...unknownKeyProblems(chosen), ...(error ? error.details.map((detail) => detail.message) : [])];

    if (problems.length > 0) {
        throw new AppError(400, "The configuration is not valid", problems);
    }

    const snapshot = freezeSnapshot({ version: CONFIGURATION_VERSION, settings: value as ConfigurationSettings });
    const snapshotText = toCanonicalJson(snapshot);

    return Object.freeze({
        profileId: profileId === undefined ? null : profileId.toLowerCase(),
        snapshot,
        snapshotText,
        hash: hashSnapshotText(snapshotText)
    });
};

// What the server checks at startup, as sentences: the default profile is there, at this code's version and inside the
// caps, and no stored profile is at another version (this code cannot read one). A profile whose settings are outside
// the caps is not a startup problem: it is shown with its problems and refused when it is resolved.
export const getConfigurationProblemsService = async (targetPool: Pool = pool): Promise<string[]> => {
    const problems: string[] = [];

    const { rows: defaults } = await targetPool.query<DefaultProfileRow>("SELECT version, settings FROM default_profile");

    if (defaults.length === 0) {
        problems.push("The default profile is missing from the default_profile table");
    } else {
        if (defaults[0].version !== CONFIGURATION_VERSION) {
            problems.push(`The default profile is at configuration version ${defaults[0].version}, and this server reads version ${CONFIGURATION_VERSION}`);
        }

        const { error } = completeSettingsSchema.validate(defaults[0].settings, { abortEarly: false });

        if (error) {
            problems.push(...error.details.map((detail) => detail.message));
        }
    }

    const { rows: stale } = await targetPool.query<{ count: number }>("SELECT count(*)::int AS count FROM profiles WHERE version <> $1", [CONFIGURATION_VERSION]);

    if (stale[0].count > 0) {
        problems.push(`${stale[0].count} stored ${stale[0].count === 1 ? "profile is" : "profiles are"} not at configuration version ${CONFIGURATION_VERSION}`);
    }

    return problems;
};
