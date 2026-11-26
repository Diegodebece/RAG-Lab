import type { Request, Response, NextFunction } from "express";
import { getActiveUserService } from "../services/auth.service.js";
import { AppError } from "../utils/appError.util.js";

// Runs after authenticateMiddleware and the per-user limit: it asks the database, so a flood of requests with
// valid tokens costs no query before the limit has counted them. One query per request answers three questions: the
// account exists, it is active and the token has its current version. It puts the role the database has now in
// req.user, so a promotion, a demotion or a disabled account applies on the very next request, with the same token.
export const currentUserMiddleware = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!req.decoded) {
            return next(new AppError(401, "Authentication required"));
        }

        const { role } = await getActiveUserService(req.decoded.id, req.decoded.tokenVersion);
        req.user = { id: req.decoded.id, role, expiresAt: req.decoded.expiresAt };
        next();
    } catch (error) {
        next(error);
    }
};
