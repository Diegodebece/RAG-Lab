import express from "express";
import { AUTHENTICATED_REQUEST_WINDOW_MS, AUTHENTICATED_REQUESTS_PER_MINUTE } from "./config/limits.config.js";
import { authenticateMiddleware } from "./middlewares/authenticate.middleware.js";
import { currentUserMiddleware } from "./middlewares/currentUser.middleware.js";
import { databaseReadyMiddleware } from "./middlewares/databaseReady.middleware.js";
import { rateLimitMiddleware } from "./middlewares/rateLimit.middleware.js";
import { authProtectedRouter, authRouter } from "./routes/auth.routes.js";
import { configurationRouter } from "./routes/configuration.routes.js";
import { healthRouter } from "./routes/health.routes.js";
import { profilesRouter } from "./routes/profiles.routes.js";
import { usersRouter } from "./routes/users.routes.js";

export const v1Router = express.Router({ mergeParams: true });

// the health check works without the database: it is what reports it as down
v1Router.use("/health", healthRouter);

// every other route needs the database; until the startup check has passed (the server started while it could not be
// reached) they answer 503, unknown paths included
v1Router.use(databaseReadyMiddleware);

// public routes
v1Router.use("/auth", authRouter);

// the token is checked first, and it costs no database query
v1Router.use(authenticateMiddleware);

// one counter per user for every protected route, on top of each route's own limits. It runs before the database
// is asked about the account, so a user over the limit costs the database nothing.
v1Router.use(rateLimitMiddleware({ limit: AUTHENTICATED_REQUESTS_PER_MINUTE, windowMs: AUTHENTICATED_REQUEST_WINDOW_MS, keyBy: "user" }));

// the account the token belongs to: it exists, it is active, the token has its current version; sets req.user with
// the role the database has now
v1Router.use(currentUserMiddleware);

// protected routes: the next layers mount theirs here
v1Router.use("/auth", authProtectedRouter);
v1Router.use("/users", usersRouter);
v1Router.use("/configuration", configurationRouter);
v1Router.use("/profiles", profilesRouter);
