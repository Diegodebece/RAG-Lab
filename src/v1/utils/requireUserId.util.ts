import type { Request } from "express";
import { AppError } from "./appError.util.js";

// The logged-in user's id, for controllers behind currentUserMiddleware. If a router is ever mounted without it,
// the request gets a 401 instead of a crash (and a 500) on an undefined req.user. A token that nothing has checked
// against the account (req.decoded) does not count as a logged-in user.
export const requireUserId = (req: Pick<Request, "user">): string => {
    if (!req.user) {
        throw new AppError(401, "Authentication required");
    }

    return req.user.id;
};

// When the logged-in user's token expires (milliseconds since 1970), with the same 401 when there is none.
export const requireTokenExpiry = (req: Pick<Request, "user">): number => {
    if (!req.user) {
        throw new AppError(401, "Authentication required");
    }

    return req.user.expiresAt;
};
