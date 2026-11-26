import jwt from "jsonwebtoken";

// A valid token for a user id, signed with the SECRET_KEY the test set before importing the app. There is no
// users table yet, so route tests identify a user by an id of their choosing.
export const signTestToken = (userId: string): string => {
    const secretKey = process.env.SECRET_KEY;

    if (!secretKey) {
        throw new Error("Set SECRET_KEY before signing test tokens");
    }

    return jwt.sign({ id: userId, role: "user" }, secretKey, { algorithm: "HS256", expiresIn: "1h" });
};

// The Authorization header of a request made by that user, ready to spread into supertest's .set(...).
export const authAs = (userId: string): [string, string] => ["Authorization", `Bearer ${signTestToken(userId)}`];
