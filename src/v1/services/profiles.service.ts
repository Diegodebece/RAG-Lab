import { pool, withTransaction } from "../config/db.config.js";
import { CONFIGURATION_VERSION } from "../config/configuration.config.js";
import { MAX_PROFILES_PER_USER } from "../config/limits.config.js";
import type { Profile } from "../types/profiles.type.js";
import { AppError } from "../utils/appError.util.js";
import { isUniqueViolation } from "../utils/dbErrors.util.js";
import { isUuid } from "../utils/uuid.util.js";
import { settingsSchema } from "../validators/configuration.validator.js";
import type { CreateProfileInput, UpdateProfileInput } from "../validators/profiles.validator.js";

// the columns of a profile row as the API shows them: not the owner (the caller already knows it) and not the version
const PROFILE_COLUMNS = `id, name, settings, created_at AS "createdAt", updated_at AS "updatedAt"`;

interface ProfileRow {
    id: string;
    name: string;
    settings: Record<string, unknown>;
    createdAt: Date;
    updatedAt: Date;
}

const NOT_FOUND_MESSAGE = "Profile not found";
const NAME_TAKEN_MESSAGE = "A profile with that name already exists";
const LIMIT_REACHED_MESSAGE = "You have reached the maximum number of profiles";

// The stored settings are shown as they are, with what is wrong with them today: a profile saved before a cap changed
// is still the user's to read, change or delete. A profile made through the API has no problems, because the route
// checked its settings first.
const toProfile = (row: ProfileRow): Profile => {
    const { error } = settingsSchema.validate(row.settings, { abortEarly: false });

    return {
        id: row.id,
        name: row.name,
        settings: row.settings,
        problems: error ? error.details.map((detail) => detail.message) : [],
        createdAt: row.createdAt,
        updatedAt: row.updatedAt
    };
};

export const getProfilesService = async (userId: string): Promise<Profile[]> => {
    const { rows } = await pool.query<ProfileRow>(
        `SELECT ${PROFILE_COLUMNS} FROM profiles WHERE user_id = $1 ORDER BY created_at, id`,
        [userId]
    );

    return rows.map(toProfile);
};

export const getProfileByIdService = async (userId: string, id: string): Promise<Profile> => {
    if (!isUuid(id)) {
        throw new AppError(404, NOT_FOUND_MESSAGE);
    }

    const { rows } = await pool.query<ProfileRow>(
        `SELECT ${PROFILE_COLUMNS} FROM profiles WHERE id = $1 AND user_id = $2`,
        [id, userId]
    );

    if (rows.length === 0) {
        throw new AppError(404, NOT_FOUND_MESSAGE);
    }

    return toProfile(rows[0]);
};

// The owner comes from the token, never from the body, and the version is the one this code reads. The limit and the
// name are checked inside one transaction that first locks the user's row: two creations that arrive together are
// served one after the other, so the second one counts the profile the first one made.
export const createProfileService = async (userId: string, profileData: CreateProfileInput): Promise<Profile> =>
    withTransaction(async (client) => {
        const { rows: owner } = await client.query("SELECT 1 FROM users WHERE id = $1 FOR UPDATE", [userId]);

        if (owner.length === 0) {
            throw new AppError(404, "User not found");
        }

        const { rows: counted } = await client.query<{ count: number }>("SELECT count(*)::int AS count FROM profiles WHERE user_id = $1", [userId]);

        if (counted[0].count >= MAX_PROFILES_PER_USER) {
            throw new AppError(409, LIMIT_REACHED_MESSAGE);
        }

        const { rows: existing } = await client.query("SELECT 1 FROM profiles WHERE user_id = $1 AND lower(name) = lower($2)", [userId, profileData.name]);

        if (existing.length > 0) {
            throw new AppError(409, NAME_TAKEN_MESSAGE);
        }

        try {
            const { rows } = await client.query<ProfileRow>(
                `INSERT INTO profiles (user_id, name, version, settings) VALUES ($1, $2, $3, $4::jsonb) RETURNING ${PROFILE_COLUMNS}`,
                [userId, profileData.name, CONFIGURATION_VERSION, JSON.stringify(profileData.settings ?? {})]
            );
            return toProfile(rows[0]);
        } catch (error) {
            if (isUniqueViolation(error)) {
                throw new AppError(409, NAME_TAKEN_MESSAGE);
            }
            throw error;
        }
    });

// The name and the settings are each optional, but one of them is there (the validator checks it). The settings sent
// replace the stored ones as a whole. The name is checked against the user's other profiles only: renaming a profile to
// its own name in another capitalization is allowed.
export const updateProfileService = async (userId: string, id: string, profileData: UpdateProfileInput): Promise<Profile> => {
    if (!isUuid(id)) {
        throw new AppError(404, NOT_FOUND_MESSAGE);
    }

    const { rows: owned } = await pool.query("SELECT 1 FROM profiles WHERE id = $1 AND user_id = $2", [id, userId]);

    if (owned.length === 0) {
        throw new AppError(404, NOT_FOUND_MESSAGE);
    }

    if (profileData.name !== undefined) {
        const { rows: existing } = await pool.query(
            "SELECT 1 FROM profiles WHERE user_id = $1 AND lower(name) = lower($2) AND id <> $3",
            [userId, profileData.name, id]
        );

        if (existing.length > 0) {
            throw new AppError(409, NAME_TAKEN_MESSAGE);
        }
    }

    try {
        const { rows } = await pool.query<ProfileRow>(
            `UPDATE profiles SET
                 name = COALESCE($3::text, name),
                 settings = COALESCE($4::jsonb, settings),
                 version = $5,
                 updated_at = now()
             WHERE id = $1 AND user_id = $2
             RETURNING ${PROFILE_COLUMNS}`,
            [
                id,
                userId,
                profileData.name ?? null,
                profileData.settings === undefined ? null : JSON.stringify(profileData.settings),
                CONFIGURATION_VERSION
            ]
        );

        if (rows.length === 0) {
            throw new AppError(404, NOT_FOUND_MESSAGE);
        }

        return toProfile(rows[0]);
    } catch (error) {
        // another request took the name between the check and the update
        if (isUniqueViolation(error)) {
            throw new AppError(409, NAME_TAKEN_MESSAGE);
        }
        throw error;
    }
};

export const deleteProfileService = async (userId: string, id: string): Promise<void> => {
    if (!isUuid(id)) {
        throw new AppError(404, NOT_FOUND_MESSAGE);
    }

    const { rows } = await pool.query<{ id: string }>("DELETE FROM profiles WHERE id = $1 AND user_id = $2 RETURNING id", [id, userId]);

    if (rows.length === 0) {
        throw new AppError(404, NOT_FOUND_MESSAGE);
    }
};
