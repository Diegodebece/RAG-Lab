// Run by test/db/testDatabase.test.ts in a child process, without test/setup.ts: the test chooses DATABASE_URL and
// MIGRATION_DATABASE_URL, and this tries to empty the database the way a test file does. It prints one line of JSON:
// "reset" when the schema was emptied, or "refused" with the message of the error that stopped it.
const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

let closePools: (() => Promise<void>) | undefined;

try {
    const helpers = await import("../testDatabase.js");
    closePools = helpers.closeTestPools;

    await helpers.emptyTestDatabase();
    console.log(JSON.stringify({ outcome: "reset" }));
} catch (error) {
    console.log(JSON.stringify({ outcome: "refused", message: describeError(error) }));
} finally {
    await closePools?.();
}
