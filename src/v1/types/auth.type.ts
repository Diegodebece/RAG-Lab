export type UserRole = "user" | "admin";

// what a token carries
export interface TokenPayload {
    id: string;
    role: UserRole;
}

// what authenticateMiddleware puts in req.decoded: the payload, plus when the token expires (milliseconds
// since 1970), which ends the user's event streams
export interface DecodedToken extends TokenPayload {
    expiresAt: number;
}
