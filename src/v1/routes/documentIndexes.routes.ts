import express from "express";
import { CONFIGURATION_BODY_LIMIT } from "../config/configuration.config.js";
import { createDocumentIndex, deleteDocumentIndex, getDocumentIndexById } from "../controllers/documentIndexes.controller.js";
import { validateBodyMiddleware } from "../middlewares/validateBody.middleware.js";
import { createDocumentIndexSchema } from "../validators/documentIndexes.validator.js";

// Mounted at /v1/documents/:id/indexes, so `id` is the document's. mergeParams gives the router that parameter.
export const documentIndexesRouter = express.Router({ mergeParams: true });

// The body holds at most two small settings, so it is read with the small limit of the configuration routes. The route has
// no limit of its own: what it spends is capped in the service, per user and for the server (a build is counted only when
// it is accepted).
documentIndexesRouter.post("/", express.json({ limit: CONFIGURATION_BODY_LIMIT }), validateBodyMiddleware(createDocumentIndexSchema), createDocumentIndex);

documentIndexesRouter.get("/:indexId", getDocumentIndexById);

documentIndexesRouter.delete("/:indexId", deleteDocumentIndex);
