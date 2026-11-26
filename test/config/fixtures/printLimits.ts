import * as limits from "../../../src/v1/config/limits.config.js";

// Run by test/config/limits.test.ts in a child process: loads the limits the way the app does, from the environment
// the test gave it, and prints them as JSON. A limit the app refuses to start with throws while the file loads.
console.log(JSON.stringify({
    TOKEN_LIFETIME_SECONDS: limits.TOKEN_LIFETIME_SECONDS,
    HEALTH_CACHE_SECONDS: limits.HEALTH_CACHE_SECONDS,
    REQUESTS_PER_ADDRESS_PER_MINUTE: limits.REQUESTS_PER_ADDRESS_PER_MINUTE,
    LOGINS_PER_15_MINUTES: limits.LOGINS_PER_15_MINUTES,
    FAILED_LOGINS_PER_EMAIL_PER_15_MINUTES: limits.FAILED_LOGINS_PER_EMAIL_PER_15_MINUTES,
    PASSWORD_CHANGES_PER_15_MINUTES: limits.PASSWORD_CHANGES_PER_15_MINUTES,
    USER_CREATIONS_PER_HOUR: limits.USER_CREATIONS_PER_HOUR
}));
