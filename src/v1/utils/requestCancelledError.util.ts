import { AppError } from "./appError.util.js";

// The caller closed the connection while its request waited for the model or while the model was answering, or the server
// is shutting down while a build runs. Nobody receives this response; the error only stops the work.
export class RequestCancelledError extends AppError {
    constructor() {
        super(503, "The request was cancelled");
        this.name = "RequestCancelledError";
    }
}
