import express from "express";
import { DOCUMENT_BODY_LIMIT, UPLOAD_REQUESTS_PER_MINUTE, UPLOAD_WINDOW_MS } from "../config/limits.config.js";
import { createDocument, deleteDocument, getDocumentById, getDocuments } from "../controllers/documents.controller.js";
import { rateLimitMiddleware } from "../middlewares/rateLimit.middleware.js";
import { validateBodyMiddleware } from "../middlewares/validateBody.middleware.js";
import { createDocumentSchema } from "../validators/documents.validator.js";
import { documentIndexesRouter } from "./documentIndexes.routes.js";

export const documentsRouter = express.Router({ mergeParams: true });

// Every user manages their own documents: there is no admin route to another user's, and the services filter by the owner
// in every query.
documentsRouter.get("/", getDocuments);

documentsRouter.get("/:id", getDocumentById);

// An upload costs the model server minutes of work, so every request counts, the refused ones too, and the count comes before
// the body is read: a client cannot make the server read a large body for nothing. The body limit is the one of the longest
// text (3 bytes a character and room for the filename), much larger than the default of 100 kB.
documentsRouter.post(
    "/",
    rateLimitMiddleware({ limit: UPLOAD_REQUESTS_PER_MINUTE, windowMs: UPLOAD_WINDOW_MS, keyBy: "user" }),
    express.json({ limit: DOCUMENT_BODY_LIMIT }),
    validateBodyMiddleware(createDocumentSchema),
    createDocument
);

documentsRouter.delete("/:id", deleteDocument);

// the indexes of a document: build one, read one, delete one
documentsRouter.use("/:id/indexes", documentIndexesRouter);
