import { randomBytes, scrypt } from "node:crypto";
import jwt from "jsonwebtoken";

// Helpers for the tests that need accounts. They do not use the app's own code to make hashes or tokens: a test
// that signed with signToken would agree with a wrong signToken. The issuer and the audience are written out here.
export const TEST_ISSUER = "rag-lab";
export const TEST_AUDIENCE = "rag-lab-api";

// The claims of a valid token: the user id, the token version and the issuer and audience of this API.
export const validClaims = (userId: string, tokenVersion = 0): Record<string, unknown> => ({
    sub: userId,
    ver: tokenVersion,
    iss: TEST_ISSUER,
    aud: TEST_AUDIENCE
});

// A token signed with the SECRET_KEY the test set before importing the app. The claims are signed exactly as given
// (no issuer or audience is added for you), and the token lives one hour unless the claims or the options say
// otherwise.
export const signTestToken = (claims: Record<string, unknown>, options: jwt.SignOptions = {}): string => {
    const secretKey = process.env.SECRET_KEY;

    if (!secretKey) {
        throw new Error("Set SECRET_KEY before signing test tokens");
    }

    const hasExpiry = "exp" in claims || "expiresIn" in options;

    return jwt.sign(claims, secretKey, { algorithm: "HS256", ...(hasExpiry ? {} : { expiresIn: "1h" }), ...options });
};

interface ScryptCost {
    N: number;
    r: number;
    p: number;
}

const CURRENT_COST: ScryptCost = { N: 16384, r: 8, p: 5 };

// A stored hash in the app's format, "scrypt$N$r$p$salt$hash", made here with node:crypto. One scrypt costs about
// 400 ms with the current parameters, so a test file computes its hash once and shares it between its users.
export const makePasswordHash = async (password: string, cost: ScryptCost = CURRENT_COST): Promise<string> => {
    const salt = randomBytes(16);
    const key = await new Promise<Buffer>((resolve, reject) => {
        scrypt(password.normalize("NFKC"), salt, 64, cost, (error, derived) => (error ? reject(error) : resolve(derived)));
    });

    return ["scrypt", cost.N, cost.r, cost.p, salt.toString("hex"), key.toString("hex")].join("$");
};

export interface TestUser {
    id: string;
    token: string;
    // the Authorization header, ready to spread into supertest's .set(...)
    auth: [string, string];
}

interface TestUserOptions {
    email: string;
    role?: "user" | "admin";
    status?: "active" | "disabled";
    // a hash from makePasswordHash; users that never log in can do without
    passwordHash?: string;
}

// Inserts the account as the database owner (the way a seed would) and returns its id and a token that is valid
// for it right now (token version 0, the version of a new account).
export const createTestUser = async ({ email, role = "user", status = "active", passwordHash = "not-a-usable-hash" }: TestUserOptions): Promise<TestUser> => {
    const { ownerPool } = await import("../db/testDatabase.js");
    const { rows } = await ownerPool.query<{ id: string }>(
        "INSERT INTO users (email, password_hash, role, status) VALUES ($1, $2, $3, $4) RETURNING id",
        [email, passwordHash, role, status]
    );
    const token = signTestToken(validClaims(rows[0].id, 0));

    return { id: rows[0].id, token, auth: ["Authorization", `Bearer ${token}`] };
};
