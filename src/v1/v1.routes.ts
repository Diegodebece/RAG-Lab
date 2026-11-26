import express from "express";
import { AUTHENTICATED_REQUEST_WINDOW_MS, AUTHENTICATED_REQUESTS_PER_MINUTE } from "./config/limits.config.js";
import { authenticateMiddleware } from "./middlewares/authenticate.middleware.js";
import { rateLimitMiddleware } from "./middlewares/rateLimit.middleware.js";
import { healthRouter } from "./routes/health.routes.js";

export const v1Router = express.Router({ mergeParams: true });

// public routes
v1Router.use("/health", healthRouter);

v1Router.use(authenticateMiddleware);

// one counter per user for every protected route, on top of each route's own limits
v1Router.use(rateLimitMiddleware({ limit: AUTHENTICATED_REQUESTS_PER_MINUTE, windowMs: AUTHENTICATED_REQUEST_WINDOW_MS, keyBy: "user" }));

// protected routes: none yet, the next layers mount theirs here
