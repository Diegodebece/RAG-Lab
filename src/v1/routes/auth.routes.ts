import express from "express";
import { loginUser, logoutUser } from "../controllers/auth.controller.js";
import { rateLimitMiddleware } from "../middlewares/rateLimit.middleware.js";
import { validateBodyMiddleware } from "../middlewares/validateBody.middleware.js";
import { loginUserSchema } from "../validators/auth.validator.js";
import { FAILED_LOGINS_PER_EMAIL_PER_15_MINUTES, LOGIN_WINDOW_MS, LOGINS_PER_15_MINUTES } from "../config/limits.config.js";

// Login, public: mounted before authenticateMiddleware.
export const authRouter = express.Router({ mergeParams: true });

// The body is parsed after the per-address limit (it does not need it) and before the per-email limit, which
// reads the email from it.
authRouter.post(
    "/login",
    rateLimitMiddleware({ limit: LOGINS_PER_15_MINUTES, windowMs: LOGIN_WINDOW_MS, keyBy: "ip" }),
    express.json(),
    rateLimitMiddleware({ limit: FAILED_LOGINS_PER_EMAIL_PER_15_MINUTES, windowMs: LOGIN_WINDOW_MS, keyBy: "emailAndIp", onlyFailures: true }),
    validateBodyMiddleware(loginUserSchema),
    loginUser
);

// Logout, behind authentication: mounted after currentUserMiddleware, so a token that was already revoked is a 401
// and does not raise the version again.
export const authProtectedRouter = express.Router({ mergeParams: true });

authProtectedRouter.post("/logout", logoutUser);
