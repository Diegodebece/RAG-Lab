// Imported first by the route tests that make many requests from one address (many logins, many accounts): it
// raises every limit so none interferes with what the file checks. The limits are read once, when their module
// loads, so this must run before the app is imported (each test file is its own process, with its own counters).
// The files that test a limit set their own value instead of importing this one.
const RELAXED = "100000";

for (const name of [
    "REQUESTS_PER_ADDRESS_PER_MINUTE",
    "AUTHENTICATED_REQUESTS_PER_MINUTE",
    "LOGINS_PER_15_MINUTES",
    "FAILED_LOGINS_PER_EMAIL_PER_15_MINUTES",
    "PASSWORD_CHANGES_PER_15_MINUTES",
    "USER_CREATIONS_PER_HOUR"
]) {
    process.env[name] = RELAXED;
}

// the uploads and the questions per minute of one user may not go above 1000: the highest value the settings accept
process.env.UPLOAD_REQUESTS_PER_MINUTE = "1000";
process.env.QUESTIONS_PER_MINUTE = "1000";

export {};
