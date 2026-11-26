// Run by test/db/testSetup.test.ts in a child process, after test/setup.ts: prints what setup left in DATABASE_URL.
console.log(process.env.DATABASE_URL ?? "unset");
