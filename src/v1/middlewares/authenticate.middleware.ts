import type { Request, Response, NextFunction } from "express";
import { getSecretKey } from "../config/auth.config.js";
import { AppError } from "../utils/appError.util.js";
import { verifyToken } from "../utils/token.util.js";

// "Bearer <token>": the scheme name is case-insensitive (RFC 9110), and there is exactly one space and exactly one
// token, so an empty token or anything after it does not match.
const BEARER_HEADER = /^bearer (\S+)$/i;

export const authenticateMiddleware = (req: Request, res: Response, next: NextFunction) => {
    const token = BEARER_HEADER.exec(req.headers.authorization ?? "")?.[1];

    if (!token) {
        return next(new AppError(401, "Authentication token is missing"));
    }

    const secretKey = getSecretKey();

    // a missing secret is a server misconfiguration, not a client error: let errorMiddleware answer 500
    if (!secretKey) {
        return next(new Error("SECRET_KEY is not set"));
    }

    const payload = verifyToken(token, secretKey);

    if (!payload) {
        return next(new AppError(401, "Invalid or expired authentication token"));
    }

    req.decoded = payload;
    next();
};
