// The model server answered, and what it answered is not what the API needs (not JSON, the wrong number of vectors, a
// vector of the wrong size). It is a plain Error, not an AppError: nothing about it is safe to show a client, and trying
// again will not fix it. Background work recognizes it by its type, to fail at once instead of retrying.
export class MalformedModelAnswerError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "MalformedModelAnswerError";
    }
}
