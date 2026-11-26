import { pool } from "../config/db.config.js";
import { getSecretKey } from "../config/auth.config.js";
import { AppError } from "../utils/appError.util.js";
import { isUniqueViolation } from "../utils/dbErrors.util.js";
import { hashPassword, verifyPassword } from "../utils/password.util.js";
import { signToken } from "../utils/token.util.js";
import { isUuid } from "../utils/uuid.util.js";
import type { AuthResult } from "../types/auth.type.js";
import type { User, UserRecord } from "../types/users.type.js";
import type { ChangePasswordInput, CreateUserInput, UpdateUserInput } from "../validators/users.validator.js";

// the columns of a User, shared with the auth service so both always return the same shape
export const USER_COLUMNS = `id, email, role, status, created_at AS "createdAt"`;

const EMAIL_TAKEN_MESSAGE = "Email is already registered";

// A valid token can outlive its account only until the next request (currentUserMiddleware checks it), hence the 404.
export const getCurrentUserService = async (userId: string): Promise<User> => {
    const { rows } = await pool.query<User>(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [userId]);

    if (rows.length === 0) {
        throw new AppError(404, "User not found");
    }

    return rows[0];
};

// Checks the current password, stores the new one and raises the token version: every token of the account stops
// working, the one that made the request included, and the answer carries a new one.
export const changeUserPasswordService = async (userId: string, passwordData: ChangePasswordInput): Promise<AuthResult> => {
    // read first, so a missing secret fails before the password is changed, not after
    const secretKey = getSecretKey();

    if (!secretKey) {
        throw new Error("SECRET_KEY is not set");
    }

    const { rows: found } = await pool.query<Pick<UserRecord, "passwordHash">>(
        `SELECT password_hash AS "passwordHash" FROM users WHERE id = $1`,
        [userId]
    );

    if (found.length === 0) {
        throw new AppError(404, "User not found");
    }

    if (!(await verifyPassword(passwordData.currentPassword, found[0].passwordHash))) {
        throw new AppError(400, "Current password is incorrect");
    }

    const newHash = await hashPassword(passwordData.newPassword);

    // only while the hash is still the one that was checked: two changes at the same time cannot both win
    const { rows } = await pool.query<User & { tokenVersion: number }>(
        `UPDATE users SET password_hash = $2, token_version = token_version + 1
         WHERE id = $1 AND password_hash = $3
         RETURNING ${USER_COLUMNS}, token_version AS "tokenVersion"`,
        [userId, newHash, found[0].passwordHash]
    );

    if (rows.length === 0) {
        throw new AppError(409, "The password was changed by another request, please try again");
    }

    const { tokenVersion, ...user } = rows[0];

    return { user, token: signToken({ id: user.id, tokenVersion }, secretKey) };
};

export const createUserService = async (userData: CreateUserInput): Promise<User> => {
    const { rows: existing } = await pool.query("SELECT 1 FROM users WHERE lower(email) = lower($1)", [userData.email]);

    if (existing.length > 0) {
        throw new AppError(409, EMAIL_TAKEN_MESSAGE);
    }

    const passwordHash = await hashPassword(userData.password);

    try {
        const { rows } = await pool.query<User>(
            `INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING ${USER_COLUMNS}`,
            [userData.email, passwordHash, userData.role ?? "user"]
        );
        return rows[0];
    } catch (error) {
        // another request created the same email between the check and the insert
        if (isUniqueViolation(error)) {
            throw new AppError(409, EMAIL_TAKEN_MESSAGE);
        }
        throw error;
    }
};

// An admin changes the role and the status of an account; the email and the password are not theirs to change.
// Disabling raises the token version, so the tokens from before stay dead when the account is enabled again; a role
// change needs no bump, because the role is read from the database on every request.
export const updateUserService = async (actorId: string, id: string, userData: UpdateUserInput): Promise<User> => {
    if (!isUuid(id)) {
        throw new AppError(404, "User not found");
    }

    // an admin who locked themselves out, or who demoted themselves by mistake, could not undo it; another admin can.
    // The id is compared in lower case: a UUID is the same account in any capitalization.
    if (id.toLowerCase() === actorId.toLowerCase()) {
        throw new AppError(409, "You cannot change your own role or status");
    }

    const { rows } = await pool.query<User>(
        `UPDATE users SET
             role = COALESCE($2::text, role),
             status = COALESCE($3::text, status),
             token_version = token_version + CASE WHEN $3::text = 'disabled' AND status <> 'disabled' THEN 1 ELSE 0 END
         WHERE id = $1
         RETURNING ${USER_COLUMNS}`,
        [id, userData.role ?? null, userData.status ?? null]
    );

    if (rows.length === 0) {
        throw new AppError(404, "User not found");
    }

    return rows[0];
};
