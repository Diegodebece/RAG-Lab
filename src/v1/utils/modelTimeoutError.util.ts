import { AppError } from "./appError.util.js";

// The model server was reached and did not answer within the time given. A request waiting for an answer gets the 504;
// background work recognizes it by its type: a request that timed out is a failure of the model server like a refused
// connection, and is told apart from "away" by asking the server whether it is up.
export class ModelTimeoutError extends AppError {
    constructor() {
        super(504, "The model server did not answer in time");
        this.name = "ModelTimeoutError";
    }
}
