import { randomBytes } from "node:crypto";
import { pool } from "../config/db.config.js";
import { getSecretKey } from "../config/auth.config.js";
import { AppError } from "../utils/appError.util.js";
import { hashPassword, needsRehash, verifyPassword } from "../utils/password.util.js";
import { signToken } from "../utils/token.util.js";
import { USER_COLUMNS } from "./users.service.js";
import type { AuthResult } from "../types/auth.type.js";
import type { User, UserRecord, UserRole } from "../types/users.type.js";
import type { LoginUserInput } from "../validators/auth.validator.js";

// the same message for an unknown email and a wrong password, so login does not reveal which accounts exist
const INVALID_CREDENTIALS_MESSAGE = "Invalid email or password";

// what every request with a token that is no longer good gets, whatever the reason: a bad signature, an account that
// was deleted or disabled, a session that ended
const INVALID_TOKEN_MESSAGE = "Invalid or expired authentication token";

// Checked against when the email does not exist, so that case takes as long as a wrong password. Made with the
// current cost parameters, once, the first time it is needed.
let dummyPasswordHash: Promise<string> | undefined;

const getDummyPasswordHash = (): Promise<string> => {
    dummyPasswordHash ??= hashPassword(randomBytes(16).toString("hex"));
    return dummyPasswordHash;
};

// server.ts refuses to start without a proper SECRET_KEY; this guards code paths that run without server.ts.
const requireSecretKey = (): string => {
    const secretKey = getSecretKey();

    if (!secretKey) {
        throw new Error("SECRET_KEY is not set");
    }

    return secretKey;
};

export const loginUserService = async (loginData: LoginUserInput): Promise<AuthResult> => {
    // read first, so a missing secret fails the same way for every email
    const secretKey = requireSecretKey();

    const { rows } = await pool.query<UserRecord>(
        `SELECT ${USER_COLUMNS}, password_hash AS "passwordHash", token_version AS "tokenVersion" FROM users WHERE lower(email) = lower($1)`,
        [loginData.email]
    );
    const record = rows[0];

    if (!record) {
        await verifyPassword(loginData.password, await getDummyPasswordHash());
        throw new AppError(401, INVALID_CREDENTIALS_MESSAGE);
    }

    // a stored hash that cannot be used (not one of ours, or cost parameters outside the allowed ranges) is a
    // password that does not match, not an error of the server
    if (!(await verifyPassword(loginData.password, record.passwordHash))) {
        throw new AppError(401, INVALID_CREDENTIALS_MESSAGE);
    }

    // said only to someone who proved they know the password, so it does not reveal which accounts exist or are disabled
    if (record.status === "disabled") {
        throw new AppError(403, "This account is disabled");
    }

    // a hash made with earlier cost parameters is replaced now that the password is known: it gets the current
    // protection, and its logins stop being faster than the others. Only while the hash is still the one that was
    // checked, so a password changed in the meantime is not overwritten with the old one.
    if (needsRehash(record.passwordHash)) {
        await pool.query(
            "UPDATE users SET password_hash = $1 WHERE id = $2 AND password_hash = $3",
            [await hashPassword(loginData.password), record.id, record.passwordHash]
        );
    }

    const user: User = { id: record.id, email: record.email, role: record.role, status: record.status, createdAt: record.createdAt };

    return { user, token: signToken({ id: record.id, tokenVersion: record.tokenVersion }, secretKey) };
};

// Raises the token version: every token of the account stops working, the one that asked for it and the ones of
// other sessions.
export const logoutUserService = async (userId: string): Promise<void> => {
    await pool.query("UPDATE users SET token_version = token_version + 1 WHERE id = $1", [userId]);
};

// The role of the account a token belongs to, when the account exists, is active and the token has its current
// version. Anything else is the same 401 as a token that does not verify. One query: it runs on every request.
export const getActiveUserService = async (id: string, tokenVersion: number): Promise<{ role: UserRole }> => {
    const { rows } = await pool.query<{ role: UserRole; status: string; tokenVersion: number }>(
        `SELECT role, status, token_version AS "tokenVersion" FROM users WHERE id = $1`,
        [id]
    );
    const record = rows[0];

    if (!record || record.status !== "active" || record.tokenVersion !== tokenVersion) {
        throw new AppError(401, INVALID_TOKEN_MESSAGE);
    }

    return { role: record.role };
};
