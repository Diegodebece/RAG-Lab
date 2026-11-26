// Whether the database has passed the startup check (the role and the migrations). It is ready unless server.ts says
// otherwise: the server starts even when the database cannot be reached, and until the check has passed the routes
// that need the database answer 503 (databaseReadyMiddleware). Code that uses the app without server.ts (the tests)
// never says otherwise.
let ready = true;

export const isDatabaseReadyService = (): boolean => ready;

export const setDatabaseReadyService = (value: boolean): void => {
    ready = value;
};
