// PostgreSQL error code for a duplicate value in a unique column or index
const UNIQUE_VIOLATION = "23505";

export const isUniqueViolation = (error: unknown): boolean =>
    error instanceof Error && "code" in error && error.code === UNIQUE_VIOLATION;

// PostgreSQL error code for a row that names a row that does not exist (or no longer does)
const FOREIGN_KEY_VIOLATION = "23503";

export const isForeignKeyViolation = (error: unknown): boolean =>
    error instanceof Error && "code" in error && error.code === FOREIGN_KEY_VIOLATION;
