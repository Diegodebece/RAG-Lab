import type { DocumentIndex } from "./documentIndexes.type.js";

// A document as the API shows it: never its text, and never the id of its owner.
export interface Document {
    id: string;
    filename: string;
    // in UTF-16 code units, the unit of the upload limit
    characterCount: number;
    // the SHA-256 (hex) of the stored text, which is how two uploads of the same text are told apart from different ones
    contentHash: string;
    createdAt: Date;
    // its indexes, ordered by chunk size and then embedding model
    indexes: DocumentIndex[];
}
