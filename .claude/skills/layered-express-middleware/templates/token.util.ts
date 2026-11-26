import jwt from "jsonwebtoken";
import { TOKEN_ALGORITHM, TOKEN_AUDIENCE, TOKEN_ISSUER } from "../config/auth.config.js";
import { TOKEN_LIFETIME_SECONDS } from "../config/limits.config.js";
import { isUuid } from "./uuid.util.js";
import type { DecodedToken, TokenPayload } from "../types/auth.type.js";

// Signing and verifying live together, so the algorithm and the claims cannot drift apart. The claims are the
// standard ones (sub, iss, aud, iat, exp) and ver, the version of the user's sessions; nothing else, and no role.
export const signToken = (payload: TokenPayload, secretKey: string): string =>
    jwt.sign({ ver: payload.tokenVersion }, secretKey, {
        algorithm: TOKEN_ALGORITHM,
        expiresIn: TOKEN_LIFETIME_SECONDS,
        subject: payload.id,
        issuer: TOKEN_ISSUER,
        audience: TOKEN_AUDIENCE
    });

// The user id, token version and expiry of a valid token, or null for anything else: a bad signature, another
// algorithm (alg: none included), another issuer or audience, an expired token, a token without an expiry (it
// would never expire), or a correctly signed token whose claims do not have the expected shape (a token of
// an earlier design, or one from another service). Whether the version is still the account's is checked
// against the database, by currentUserMiddleware.
export const verifyToken = (token: string, secretKey: string): DecodedToken | null => {
    let decoded: string | jwt.JwtPayload;

    try {
        decoded = jwt.verify(token, secretKey, { algorithms: [TOKEN_ALGORITHM], issuer: TOKEN_ISSUER, audience: TOKEN_AUDIENCE });
    } catch {
        return null;
    }

    if (typeof decoded !== "object" || typeof decoded.exp !== "number" || typeof decoded.sub !== "string" || !isUuid(decoded.sub)) {
        return null;
    }

    const version: unknown = decoded.ver;

    if (typeof version !== "number" || !Number.isInteger(version) || version < 0) {
        return null;
    }

    return { id: decoded.sub, tokenVersion: version, expiresAt: decoded.exp * 1000 };
};
