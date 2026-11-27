import express from "express";
import { CONFIGURATION_BODY_LIMIT } from "../config/configuration.config.js";
import { createProfile, deleteProfile, getProfileById, getProfiles, updateProfile } from "../controllers/profiles.controller.js";
import { validateBodyMiddleware } from "../middlewares/validateBody.middleware.js";
import { createProfileSchema, updateProfileSchema } from "../validators/profiles.validator.js";

export const profilesRouter = express.Router({ mergeParams: true });

// Every user manages their own profiles: there is no admin route to another user's, and the services filter by the
// owner in every query.
profilesRouter.get("/", getProfiles);

profilesRouter.post("/", express.json({ limit: CONFIGURATION_BODY_LIMIT }), validateBodyMiddleware(createProfileSchema), createProfile);

profilesRouter.get("/:id", getProfileById);

profilesRouter.patch("/:id", express.json({ limit: CONFIGURATION_BODY_LIMIT }), validateBodyMiddleware(updateProfileSchema), updateProfile);

profilesRouter.delete("/:id", deleteProfile);
