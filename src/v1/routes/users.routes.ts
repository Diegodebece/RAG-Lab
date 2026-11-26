import express from "express";
import { changeUserPassword, createUser, getCurrentUser, updateUser } from "../controllers/users.controller.js";
import { authorizeMiddleware } from "../middlewares/authorize.middleware.js";
import { rateLimitMiddleware } from "../middlewares/rateLimit.middleware.js";
import { validateBodyMiddleware } from "../middlewares/validateBody.middleware.js";
import { changePasswordSchema, createUserSchema, updateUserSchema } from "../validators/users.validator.js";
import {
    PASSWORD_CHANGE_WINDOW_MS,
    PASSWORD_CHANGES_PER_15_MINUTES,
    USER_CREATION_WINDOW_MS,
    USER_CREATIONS_PER_HOUR
} from "../config/limits.config.js";

export const usersRouter = express.Router({ mergeParams: true });

usersRouter.get("/me", getCurrentUser);

// every attempt counts, the wrong ones too: the route checks a password, so it is a way to guess one
usersRouter.patch(
    "/me/password",
    rateLimitMiddleware({ limit: PASSWORD_CHANGES_PER_15_MINUTES, windowMs: PASSWORD_CHANGE_WINDOW_MS, keyBy: "user" }),
    express.json(),
    validateBodyMiddleware(changePasswordSchema),
    changeUserPassword
);

// After the permission check, so a user is told 403 and what they try does not use up an admin's attempts. Only the
// accounts actually created count: a typo in an email does not use up the hour's allowance.
usersRouter.post(
    "/",
    authorizeMiddleware(["admin"]),
    rateLimitMiddleware({ limit: USER_CREATIONS_PER_HOUR, windowMs: USER_CREATION_WINDOW_MS, keyBy: "user", onlySuccesses: true }),
    express.json(),
    validateBodyMiddleware(createUserSchema),
    createUser
);

usersRouter.patch("/:id", authorizeMiddleware(["admin"]), express.json(), validateBodyMiddleware(updateUserSchema), updateUser);
