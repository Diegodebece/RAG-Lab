import express from "express";
import { CONFIGURATION_BODY_LIMIT } from "../config/configuration.config.js";
import { getConfiguration, resolveConfiguration } from "../controllers/configuration.controller.js";
import { validateBodyMiddleware } from "../middlewares/validateBody.middleware.js";
import { resolveConfigurationSchema } from "../validators/configuration.validator.js";

export const configurationRouter = express.Router({ mergeParams: true });

configurationRouter.get("/", getConfiguration);

// The body is optional: a request with none resolves the default profile (validateBodyMiddleware reads a missing body
// as {}).
configurationRouter.post("/resolve", express.json({ limit: CONFIGURATION_BODY_LIMIT }), validateBodyMiddleware(resolveConfigurationSchema), resolveConfiguration);
