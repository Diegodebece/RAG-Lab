import type { AuthenticatedUser, DecodedToken } from "./auth.type.js";

declare global {
    namespace Express {
        interface Request {
            // set by authenticateMiddleware: what the token says
            decoded?: DecodedToken;
            // set by currentUserMiddleware: the account the token belongs to, with the role the database has now
            user?: AuthenticatedUser;
            validatedBody?: unknown;
        }
    }
}
