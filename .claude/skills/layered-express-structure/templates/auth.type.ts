import type { User, UserRole } from "./users.type.js";

// what a token carries: the user and the version of their sessions. The role is not in it: it is read from the
// database on every request, so a promotion or a demotion applies at once.
export interface TokenPayload {
    id: string;
    tokenVersion: number;
}

// what authenticateMiddleware puts in req.decoded: the payload, plus when the token expires (milliseconds
// since 1970), which ends the user's event streams. It is only what the token says; nothing has checked it
// against the account yet.
export interface DecodedToken extends TokenPayload {
    expiresAt: number;
}

// what currentUserMiddleware puts in req.user, once the account is known to exist, be active and have this
// token's version: the id, the role the database has now and when the token expires
export interface AuthenticatedUser {
    id: string;
    role: UserRole;
    expiresAt: number;
}

// returned by login and by a password change
export interface AuthResult {
    user: User;
    token: string;
}
