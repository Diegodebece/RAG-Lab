import "dotenv/config";
import { randomBytes } from "node:crypto";
import { pool } from "./v1/config/db.config.js";
import { createUserService } from "./v1/services/users.service.js";
import { AppError } from "./v1/utils/appError.util.js";
import { emailRule } from "./v1/validators/auth.validator.js";

// Creates the first admin: there is no self-registration, so the owner runs this once (`npm run create-admin --
// <email>`), logs in with the password it prints, and creates the other accounts through the API. It connects with
// DATABASE_URL, the API role, like the server: it needs no other rights, no SECRET_KEY and no migration URL.

// 18 random bytes written in base64url are exactly 24 characters (letters, digits, "-" and "_"): 144 bits.
const PASSWORD_BYTES = 18;

const run = async (): Promise<void> => {
    const [rawEmail] = process.argv.slice(2);

    if (rawEmail === undefined) {
        console.error("Usage: npm run create-admin -- <email>\nAn email is required: the address the admin logs in with.");
        process.exitCode = 1;
        return;
    }

    // the same rule as every account's email: trimmed, lowercased, in Unicode form NFC, at most 254 characters
    const { error, value } = emailRule.validate(rawEmail);

    if (error) {
        console.error(`Invalid email: ${error.message}`);
        process.exitCode = 1;
        return;
    }

    // the text Joi gave back after trimming and lowercasing
    const email = value as string;

    const password = randomBytes(PASSWORD_BYTES).toString("base64url");

    try {
        await createUserService({ email, password, role: "admin" });
    } catch (creationError) {
        // "Email is already registered": nothing was changed, and no password is printed
        console.error(creationError instanceof AppError ? `Could not create the admin: ${creationError.message}` : creationError);
        process.exitCode = 1;
        return;
    }

    // the only time the password is shown; only its hash is stored
    console.log(`Admin created: ${email}`);
    console.log(`Password (shown only once, store it now): ${password}`);
};

try {
    await run();
} catch (error) {
    console.error(error);
    process.exitCode = 1;
} finally {
    await pool.end();
}
