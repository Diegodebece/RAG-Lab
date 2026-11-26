import type { Request, Response, NextFunction } from "express";
import { isDatabaseReadyService } from "../services/databaseReadiness.service.js";
import { AppError } from "../utils/appError.util.js";
import { DATABASE_UNAVAILABLE_MESSAGE } from "../utils/databaseError.util.js";

// Before authentication: the account check needs the database, and so does everything after it. Answers 503 until
// server.ts has run the startup check against the database (see databaseReadiness.service.ts).
export const databaseReadyMiddleware = (req: Request, res: Response, next: NextFunction) => {
    if (!isDatabaseReadyService()) {
        return next(new AppError(503, DATABASE_UNAVAILABLE_MESSAGE));
    }

    next();
};
