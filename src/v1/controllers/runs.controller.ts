import type { Request, Response, NextFunction } from "express";
import { searchDocumentService } from "../services/runs.service.js";
import { requireUserId } from "../utils/requireUserId.util.js";
import type { SearchDocumentInput } from "../validators/runs.validator.js";

// The search runs within the request, after the question's turn with the model. If the client disconnects before the response
// is sent, the signal takes the question out of the line, or stops its embedding. A client that is already gone when the controller
// starts (it hung up while the request waited in the middleware before it) never raises a "close" event again, so the signal is
// aborted at once when the request is destroyed or the response closed. It answers 200: nothing can be fetched later, because no
// route reads a run back yet.
export const searchDocument = async (req: Request<{ id: string }>, res: Response, next: NextFunction) => {
    try {
        const cancelled = new AbortController();
        res.on("close", () => {
            if (!res.writableFinished) {
                cancelled.abort();
            }
        });

        if (req.destroyed || res.closed) {
            cancelled.abort();
        }

        const run = await searchDocumentService(requireUserId(req), req.params.id, req.validatedBody as SearchDocumentInput, cancelled.signal);
        return res.status(200).json({ success: true, message: "Search completed successfully", data: run });
    } catch (error) {
        next(error);
    }
};
