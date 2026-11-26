// Run by test/db/testSetup.test.ts in a child process, after test/setup.ts: prints, as JSON, what setup left in the
// two database variables (null when one is not set).
console.log(JSON.stringify({
    DATABASE_URL: process.env.DATABASE_URL ?? null,
    MIGRATION_DATABASE_URL: process.env.MIGRATION_DATABASE_URL ?? null
}));
