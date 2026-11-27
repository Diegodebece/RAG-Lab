import express from "express";
import { CONFIGURATION_BODY_LIMIT } from "../config/configuration.config.js";
import { UPLOAD_REQUESTS_PER_MINUTE, UPLOAD_WINDOW_MS } from "../config/limits.config.js";
import { createDocumentIndex, deleteDocumentIndex, getDocumentIndexById } from "../controllers/documentIndexes.controller.js";
import { rateLimitMiddleware } from "../middlewares/rateLimit.middleware.js";
import { validateBodyMiddleware } from "../middlewares/validateBody.middleware.js";
import { createDocumentIndexSchema } from "../validators/documentIndexes.validator.js";

// Mounted at /v1/documents/:id/indexes, so `id` is the document's. mergeParams gives the router that parameter.
export const documentIndexesRouter = express.Router({ mergeParams: true });

// A build costs the model server minutes of work, so every request counts, the refused ones and the ones that find the index
// already there too, and the count comes before the body is read. The limit is the one of uploads (UPLOAD_REQUESTS_PER_MINUTE,
// no setting of its own) with a counter of its own, so uploading does not use up the builds and the other way round. The
// service also caps what a build spends, per user and for the server (a build is counted only when it is accepted). The body
// holds at most two small settings, so it is read with the small limit of the configuration routes. Reading and deleting an
// index are not counted here.
documentIndexesRouter.post(
    "/",
    rateLimitMiddleware({ limit: UPLOAD_REQUESTS_PER_MINUTE, windowMs: UPLOAD_WINDOW_MS, keyBy: "user" }),
    express.json({ limit: CONFIGURATION_BODY_LIMIT }),
    validateBodyMiddleware(createDocumentIndexSchema),
    createDocumentIndex
);

documentIndexesRouter.get("/:indexId", getDocumentIndexById);

documentIndexesRouter.delete("/:indexId", deleteDocumentIndex);
