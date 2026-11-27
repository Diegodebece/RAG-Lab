import express from "express";
import { CONFIGURATION_BODY_LIMIT } from "../config/configuration.config.js";
import { DOCUMENT_BODY_LIMIT, QUESTION_WINDOW_MS, QUESTIONS_PER_MINUTE, UPLOAD_REQUESTS_PER_MINUTE, UPLOAD_WINDOW_MS } from "../config/limits.config.js";
import { createDocument, deleteDocument, getDocumentById, getDocuments } from "../controllers/documents.controller.js";
import { searchDocument } from "../controllers/runs.controller.js";
import { rateLimitMiddleware } from "../middlewares/rateLimit.middleware.js";
import { validateBodyMiddleware } from "../middlewares/validateBody.middleware.js";
import { createDocumentSchema } from "../validators/documents.validator.js";
import { searchDocumentSchema } from "../validators/runs.validator.js";
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

// A search costs the model server an embedding, so every request counts, the refused ones too, and the count comes before the body
// is read. It has a counter of its own (QUESTIONS_PER_MINUTE, per user and token version, in memory; the daily count is in the
// database, from the runs). The body is a question and at most six small settings, so it is read with the small limit of the
// configuration routes. Before the nested router, so /:id/search is never taken for something under /:id/indexes.
documentsRouter.post(
    "/:id/search",
    rateLimitMiddleware({ limit: QUESTIONS_PER_MINUTE, windowMs: QUESTION_WINDOW_MS, keyBy: "user" }),
    express.json({ limit: CONFIGURATION_BODY_LIMIT }),
    validateBodyMiddleware(searchDocumentSchema),
    searchDocument
);

// the indexes of a document: build one, read one, delete one
documentsRouter.use("/:id/indexes", documentIndexesRouter);
