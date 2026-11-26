import type { Request, Response, NextFunction } from "express";
import { AppError } from "../utils/appError.util.js";

// Reads the role of req.user, which currentUserMiddleware took from the database on this request. The token has no
// role, and a request that was only authenticated (req.decoded) has not been checked against the account yet.
export const authorizeMiddleware = (roles: string[] = []) => (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
        return next(new AppError(401, "Authentication required"));
    }

    if (!roles.includes(req.user.role)) {
        return next(new AppError(403, "You do not have permission to perform this action"));
    }

    next();
};
